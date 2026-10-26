"""Opt-in local k3s integration. Never uses a production kubeconfig.
Run: python msa/deploy/tests/integration_app_rollout.py --image dva-customer:local
"""
import argparse
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
    parser.add_argument('--image', default='dva-customer:local')
    parser.add_argument('--cluster', help='Existing disposable test container, must start with dva-delivery-check-')
    args = parser.parse_args()
    cluster = args.cluster or 'dva-delivery-check-' + uuid.uuid4().hex[:8]
    if not cluster.startswith('dva-delivery-check-'):
        raise ValueError('Refusing non-test container')
    created = not args.cluster
    original = Path.cwd()
    samples = []
    stop = threading.Event()
    monitor = None
    try:
        if created:
            command(['docker', 'run', '-d', '--privileged', '--name', cluster, '-p', '127.0.0.1::30081',
                     '-e', 'K3S_TOKEN=local-delivery-check-only', 'rancher/k3s:v1.35.5-k3s1',
                     'server', '--disable', 'traefik', '--disable', 'metrics-server', '--disable', 'servicelb',
                     '--node-name', 'delivery-check'])
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
                if nodes and any(c['type'] == 'Ready' and c['status'] == 'True' for c in nodes[0]['status']['conditions']):
                    break
            except Exception:
                pass
            time.sleep(2)
        else:
            raise RuntimeError('Local k3s did not become Ready')
        kube('apply', '-f', '-', data=json.dumps({'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'dva'}}))
        port = command(['docker', 'port', cluster, '30081/tcp']).strip()
        url = f'http://{port}/customer/health'
        with tempfile.TemporaryDirectory() as temp, contextlib.chdir(temp):
            command(['docker', 'save', '-o', str(Path('image.tar').resolve()), args.image])
            command(['docker', 'cp', 'image.tar', cluster + ':/tmp/customer.tar'])
            command(['docker', 'exec', cluster, '/bin/ctr', '-n', 'k8s.io', 'images', 'import', '/tmp/customer.tar'])
            source = args.image if '/' in args.image else 'docker.io/library/' + args.image
            manifest = (ROOT / 'msa/services/customer/k8s.yaml').read_text(encoding='utf-8')
            # Local NodePort exercises Service traffic; production HTTPS is checked separately.
            manifest = '---'.join(manifest.split('---')[:2])
            resources = app.parse_resources(kube('create', '--dry-run=client', '-f', '-', '-o', 'json', data=manifest))
            dep = next(r for r in resources if r['kind'] == 'Deployment')
            svc = next(r for r in resources if r['kind'] == 'Service')
            svc['spec']['type'] = 'NodePort'
            svc['spec']['ports'][0]['nodePort'] = 30081
            dep['spec']['progressDeadlineSeconds'] = 30
            def deploy(letter, number, broken=False):
                release = letter * 40 + '-' + str(number)
                image = 'docker.io/library/dva-customer:' + release
                command(['docker', 'exec', cluster, '/bin/ctr', '-n', 'k8s.io', 'images', 'tag', '--force', source, image])
                candidate = copy.deepcopy(resources)
                deployment = next(r for r in candidate if r['kind'] == 'Deployment')
                container = deployment['spec']['template']['spec']['containers'][0]
                container['image'] = image
                if broken:
                    container['readinessProbe']['httpGet']['path'] = '/intentionally-not-ready'
                Path('k8s.yaml').write_text(json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': candidate}))
                app.apply_release('customer', release, image)
                return image
            def wait_stable():
                for _ in range(60):
                    if app.ready(json.loads(kube('-n', 'dva', 'get', 'deployment', 'customer', '-o', 'json'))):
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
            actual = json.loads(kube('-n', 'dva', 'get', 'deployment', 'customer', '-o', 'json'))
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
        if created:
            subprocess.run(['docker', 'rm', '-fv', cluster], check=False)


if __name__ == '__main__':
    main()
