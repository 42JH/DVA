"""Opt-in local k3s integration. Never uses a production kubeconfig.
Run: python msa/deploy/tests/integration_app_rollout.py --image dva-customer:local
"""
import argparse
import base64
import copy
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('app_release', ROOT / 'msa/deploy/app-release.py')
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def command(args, data=None, timeout=360):
    result = subprocess.run(args, input=data, capture_output=True, text=True, timeout=timeout, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(f'{args}: {result.stdout}\n{result.stderr}')
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--service', default='customer', choices=['customer', 'order', 'delivery', 'consultation', 'operations'])
    parser.add_argument('--image', default='dva-customer:local')
    parser.add_argument('--cluster', help='Existing disposable test container, must start with dva-delivery-check-')
    args = parser.parse_args()
    service = args.service
    cluster = args.cluster or 'dva-delivery-check-' + uuid.uuid4().hex[:8]
    if not cluster.startswith('dva-delivery-check-'):
        raise ValueError('Refusing non-test container')
    created = not args.cluster
    original = Path.cwd()
    samples = []
    stop = threading.Event()
    monitor = None
    cluster_created = False
    database_resources = []
    try:
        db_services = ('operations', 'customer', 'consultation') if service == 'consultation' else ('operations', 'customer') if service == 'customer' else ('operations',) if service == 'operations' else ()
        addresses = {}
        if db_services:
            if not created:
                raise ValueError('DB fixtures require a newly created disposable cluster')
            network = cluster + '-databases'
            image = network + '-liquibase'
            label = 'dva.test-run=' + cluster
            command(['docker', 'network', 'create', '--internal', '--label', label, network])
            database_resources.append(('network', network))
            command(['docker', 'build', '--label', label, '-t', image, str(ROOT / 'msa/liquibase')])
            database_resources.append(('image', image))
            for db_service in db_services:
                database = network + '-' + db_service
                command(['docker', 'run', '-d', '--name', database, '--label', label, '--network', network,
                         '--tmpfs', '/var/lib/postgresql/data', '-e', f'POSTGRES_USER={db_service}_app',
                         '-e', 'POSTGRES_DB=dva_webhook_test', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
                         'postgres:17.11-bookworm'])
                database_resources.append(('container', database))
                for _ in range(60):
                    ready = subprocess.run(['docker', 'exec', database, 'pg_isready', '-h', '127.0.0.1',
                                            '-U', f'{db_service}_app'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    if ready.returncode == 0:
                        break
                    time.sleep(1)
                else:
                    raise RuntimeError(db_service + ' rollout test DB not ready')
                command(['docker', 'run', '--rm', '--network', network,
                         '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{database}:5432/dva_webhook_test',
                         '-e', f'LIQUIBASE_COMMAND_USERNAME={db_service}_app', image,
                         f'--changelog-file={db_service}/db.changelog.xml', 'update'])
                addresses[db_service] = command(['docker', 'inspect', database, '--format',
                                               '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).strip()
        if created:
            command(['docker', 'run', '-d', '--privileged', '--name', cluster, '--label', 'dva.test-run=' + cluster, '-p', '127.0.0.1::30081',
                     '-e', 'K3S_TOKEN=local-delivery-check-only', 'rancher/k3s:v1.35.5-k3s1',
                     'server', '--disable', 'traefik', '--disable', 'metrics-server', '--disable', 'servicelb',
                     '--node-name', 'delivery-check'])
            cluster_created = True
        if db_services:
            command(['docker', 'network', 'connect', network, cluster])
        def kube(*options, data=None):
            options = list(options)
            if '-f' in options:
                index = options.index('-f') + 1
                if options[index] != '-':
                    data = Path(options[index]).read_text(encoding='utf-8')
                    options[index] = '-'
            return command(['docker', 'exec', '-i', cluster, '/bin/kubectl', *options], data)
        app.kube = kube
        for attempt in range(90):
            try:
                nodes = json.loads(kube('get', 'nodes', '-o', 'json'))['items']
                if (nodes and any(c['type'] == 'Ready' and c['status'] == 'True' for c in nodes[0]['status']['conditions'])
                        and kube('-n', 'kube-system', 'get', 'deployment', 'coredns', '--ignore-not-found', '-o', 'name').strip()):
                    break
            except Exception:
                pass
            time.sleep(2)
        else:
            raise RuntimeError('Local k3s did not become Ready')
        kube('-n', 'kube-system', 'rollout', 'status', 'deployment/coredns', '--timeout=120s')
        kube('apply', '-f', '-', data=json.dumps({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'dva'}}))
        for db_service in db_services:
            kube('apply', '-f', '-', data=json.dumps({
                'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': db_service + '-db', 'namespace': 'dva'},
                'stringData': {'PGHOST': addresses[db_service], 'PGPORT': '5432', 'PGUSER': db_service + '_app',
                               'PGPASSWORD': 'disposable-test-only', 'PGDATABASE': 'dva_webhook_test'},
            }))
        if db_services:
            app.ensure_service_auth_secret('customer')
            app.ensure_service_auth_secret('consultation')
            tokens = {peer: base64.b64decode(json.loads(kube('-n', 'dva', 'get', 'secret', 'msa-' + peer + '-auth', '-o', 'json'))['data'][peer + '-token']).decode('ascii') for peer in ('customer', 'consultation')}
        if service in ('customer', 'consultation'):
            operations = network + '-operations-app'
            command(['docker', 'build', '--label', label, '-t', operations, '-f', str(ROOT / 'msa/services/operations/Dockerfile'), str(ROOT / 'msa')])
            database_resources.append(('image', operations))
            command(['docker', 'run', '-d', '--name', operations, '--label', label, '--network', network,
                     '-e', 'NODE_ENV=production', '-e', 'PORT=3005', '-e', 'SWAGGER_ENABLED=true',
                     '-e', f'DB_HOST={addresses["operations"]}', '-e', 'DB_PORT=5432',
                     '-e', 'DB_USER=operations_app', '-e', 'DB_PASSWORD=disposable-test-only',
                     '-e', 'DB_NAME=dva_webhook_test', '-e', 'CUSTOMER_AUTH_TOKEN=' + tokens['customer'],
                     '-e', 'CONSULTATION_AUTH_TOKEN=' + tokens['consultation'], operations])
            database_resources.append(('container', operations))
            operations_address = command(['docker', 'inspect', operations, '--format',
                                          '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).strip()
        if service == 'consultation':
            customer = network + '-customer-app'
            command(['docker', 'build', '--label', label, '-t', customer, '-f', str(ROOT / 'msa/services/customer/Dockerfile'), str(ROOT / 'msa')])
            database_resources.append(('image', customer))
            command(['docker', 'run', '-d', '--name', customer, '--label', label, '--network', network,
                     '-e', 'NODE_ENV=production', '-e', 'PORT=3001', '-e', 'SWAGGER_ENABLED=true',
                     '-e', 'DB_HOST=' + addresses['customer'], '-e', 'DB_USER=customer_app', '-e', 'DB_PORT=5432',
                     '-e', 'DB_PASSWORD=disposable-test-only', '-e', 'DB_NAME=dva_webhook_test',
                     '-e', 'OPERATIONS_URL=http://' + operations_address + ':3005',
                     '-e', 'CUSTOMER_AUTH_TOKEN=' + tokens['customer'], '-e', 'CONSULTATION_AUTH_TOKEN=' + tokens['consultation'], customer])
            database_resources.append(('container', customer))
            customer_address = command(['docker', 'inspect', customer, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}']).strip()
        port = command(['docker', 'port', cluster, '30081/tcp']).strip()
        url = f'http://{port}/{service}/health'
        with tempfile.TemporaryDirectory() as temp, contextlib.chdir(temp):
            command(['docker', 'save', '-o', str(Path('image.tar').resolve()), args.image])
            command(['docker', 'cp', 'image.tar', cluster + ':/tmp/customer.tar'])
            command(['docker', 'exec', cluster, '/bin/ctr', '-n', 'k8s.io', 'images', 'import', '/tmp/customer.tar'])
            source = args.image if '/' in args.image else 'docker.io/library/' + args.image
            manifest = (ROOT / f'msa/services/{service}/k8s.yaml').read_text(encoding='utf-8')
            kube('apply', '--dry-run=server', '-f', '-', data=manifest)
            # Local NodePort exercises Service traffic; production HTTPS is checked separately.
            manifest = '---'.join(manifest.split('---')[:2])
            resources = app.parse_resources(kube('create', '--dry-run=client', '-f', '-', '-o', 'json', data=manifest))
            dep = next(r for r in resources if r['kind'] == 'Deployment')
            if service in ('customer', 'consultation'):
                env = dep['spec']['template']['spec']['containers'][0]['env']
                next(item for item in env if item['name'] == 'OPERATIONS_URL')['value'] = f'http://{operations_address}:3005'
                if service == 'consultation':
                    next(item for item in env if item['name'] == 'CUSTOMER_URL')['value'] = f'http://{customer_address}:3001'
            svc = next(r for r in resources if r['kind'] == 'Service')
            svc['spec']['type'] = 'NodePort'
            svc['spec']['ports'][0]['nodePort'] = 30081
            dep['spec']['progressDeadlineSeconds'] = 30
            def deploy(letter, number, broken=False):
                release = letter * 40 + '-' + str(number)
                image = f'docker.io/library/dva-{service}:' + release
                command(['docker', 'exec', cluster, '/bin/ctr', '-n', 'k8s.io', 'images', 'tag', '--force', source, image])
                candidate = copy.deepcopy(resources)
                deployment = next(r for r in candidate if r['kind'] == 'Deployment')
                container = deployment['spec']['template']['spec']['containers'][0]
                container['image'] = image
                if broken:
                    container['readinessProbe']['httpGet']['path'] = '/intentionally-not-ready'
                Path('k8s.yaml').write_text(json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': candidate}))
                app.apply_release(service, release, image)
                return image
            def wait_stable():
                for _ in range(60):
                    if app.ready(json.loads(kube('-n', 'dva', 'get', 'deployment', service, '-o', 'json'))):
                        return
                    time.sleep(1)
                raise RuntimeError('Deployment did not settle')
            deploy('a', 1)
            wait_stable()
            with urllib.request.urlopen(url, timeout=5) as response:
                assert json.load(response)['status'] == 'ok'
            def observe():
                while not stop.is_set():
                    try:
                        with urllib.request.urlopen(url, timeout=3) as response:
                            ok = response.status == 200 and json.load(response).get('status') == 'ok'
                        samples.append(ok)
                    except Exception:
                        samples.append(False)
                    stop.wait(0.1)
            monitor = threading.Thread(target=observe)
            monitor.start()
            expected = deploy('b', 2)
            wait_stable()
            try:
                deploy('c', 3, broken=True)
            except RuntimeError:
                pass
            else:
                raise AssertionError('Broken rollout incorrectly succeeded')
            wait_stable()
            actual = json.loads(kube('-n', 'dva', 'get', 'deployment', service, '-o', 'json'))
            assert actual['spec']['template']['spec']['containers'][0]['image'] == expected
            assert actual['metadata']['annotations']['dva.ssafy.io/deployed-commit'] == 'b' * 40
            stop.set()
            monitor.join()
            assert len(samples) >= 20 and all(samples), f'Failed requests: {samples.count(False)}/{len(samples)}'
            print(json.dumps({'passed': True, 'requests': len(samples), 'failedRequests': samples.count(False),
                              'rollingUpdate': True, 'failedRolloutRestored': True,
                              'clusterVersion': 'v1.35.5+k3s1'}, indent=2))
    finally:
        stop.set()
        if monitor:
            monitor.join(timeout=5)
        os.chdir(original)
        if cluster_created:
            item = json.loads(command(['docker', 'inspect', cluster]))[0]
            if item.get('Config', {}).get('Labels', {}).get('dva.test-run') != cluster:
                raise RuntimeError('Refusing cleanup of unowned rollout cluster')
            subprocess.run(['docker', 'rm', '-fv', cluster], check=False)
        for kind, name in reversed(database_resources):
            item = json.loads(command(['docker', kind, 'inspect', name]))[0]
            labels = item.get('Labels') if kind == 'network' else item.get('Config', {}).get('Labels')
            if not labels or labels.get('dva.test-run') != cluster:
                raise RuntimeError('Refusing cleanup of unowned DB fixture: ' + name)
            command(['docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name])


if __name__ == '__main__':
    main()
