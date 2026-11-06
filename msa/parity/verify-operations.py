"""Compare operations against the unchanged monolith on disposable Docker DBs."""
import json
import importlib.util
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
RUN = 'dva-operations-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN
LOGS = ROOT / 'msa/liquibase/verification-logs/operations'


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    resources = []
    report = {'passed': False, 'checks': [], 'reference': subprocess.check_output(
        ['git', 'rev-parse', 'HEAD:backend'], cwd=ROOT, text=True).strip()}

    def run(*args, label, data=None):
        result = subprocess.run(args, input=data, text=True, encoding='utf-8',
                                errors='replace', stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=900, cwd=ROOT)
        (LOGS / (label + '.log')).write_text(result.stdout, encoding='utf-8')
        if result.returncode:
            raise RuntimeError(label + ': ' + result.stdout[-6000:])
        report['checks'].append(label)
        print(label, flush=True)
        return result.stdout.strip()

    def create(name, image, *args, command=()):
        run('docker', 'create', '--name', name, '--label', LABEL, '--network', RUN,
            *args, image, *command, label=name + '-create')
        resources.append(('container', name))

    def complete(name):
        run('docker', 'start', '--attach', name, label=name + '-run')
        code = run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name + '-exit')
        if code != '0':
            raise RuntimeError(name + ' exited with ' + code)

    def copy(source, name, destination):
        run('docker', 'cp', str(ROOT / source), name + ':' + destination,
            label=name + '-copy-' + Path(source).name)

    password = uuid.uuid4().hex
    try:
        images = {}
        for name, path, target in (
            ('operations-checks', 'msa/services/operations', 'checks'),
            ('operations', 'msa/services/operations', None),
            ('monolith-checks', 'backend', 'checks'),
            ('monolith', 'backend', None),
            ('liquibase', 'msa/liquibase', None),
        ):
            image = RUN + '-' + name
            resources.append(('image', image))
            run('docker', 'build', '--label', LABEL, '-t', image,
                *(['--target', target] if target else []), *(['-f', str(ROOT / path / 'Dockerfile'), str(ROOT / 'msa')] if path.startswith('msa/services/') else [str(ROOT / path)]), label=name + '-build')
            images[name] = image
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        addresses = {}
        for side in ('monolith', 'operations'):
            name = RUN + '-' + side + '-db'
            create(name, 'postgres:17.11-bookworm', '--network-alias', side + '-db',
                   '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=operations_app',
                   '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=dva_webhook_test')
            run('docker', 'start', name, label=side + '-db-start')
            for _ in range(60):
                ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1',
                                        '-U', 'operations_app'], stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError(side + ' DB not ready')
            addresses[side] = run('docker', 'inspect', name, '--format',
                                 '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', label=side + '-db-address')
        name = RUN + '-migrate'
        create(name, images['liquibase'],
               '-e', 'LIQUIBASE_COMMAND_URL=jdbc:postgresql://operations-db:5432/dva_webhook_test',
               '-e', 'LIQUIBASE_COMMAND_USERNAME=operations_app',
               '-e', 'LIQUIBASE_COMMAND_PASSWORD=' + password,
               command=('--changelog-file=operations/db.changelog.xml', 'update'))
        complete(name)
        common = ['-e', 'DB_USER=operations_app', '-e', 'DB_PASSWORD=' + password,
                  '-e', 'DB_NAME=dva_webhook_test', '-e', 'AI_AGENT_URL=http://ai.invalid:8000',
                  '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true',
                  '-e', 'SECURITY_LOG_HMAC_KEY=' + uuid.uuid4().hex + uuid.uuid4().hex]
        for side in ('monolith', 'operations'):
            name = RUN + '-' + side + '-suite'
            create(name, images[side + '-checks'], *common, '--add-host=db:' + addresses[side],
                   '-e', 'NODE_ENV=test', '-e', 'DB_HOST=db', command=('node', '--test',
                   '--test-concurrency=1', 'test/auth.test.cjs', 'test/auth.integration.test.cjs',
                   *(['test/environment.test.cjs'] if side == 'operations' else [])))
            if side == 'operations':
                for file in ('auth.test.cjs', 'auth.integration.test.cjs'):
                    copy('backend/test/' + file, name, '/app/service/test/' + file)
            complete(name)
            name = RUN + '-' + side + '-app'
            create(name, images[side], *common, '--network-alias', side + '-app',
                   '--network-alias', side,
                   '-e', 'NODE_ENV=production', '-e', 'DB_HOST=' + side + '-db', '-e', 'PORT=3005')
            run('docker', 'start', name, label=side + '-app-start')
        name = RUN + '-differential'
        create(name, images['operations-checks'], '-e', 'NODE_ENV=test',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               '-e', 'PGDATABASE=dva_webhook_test', command=('node', '--test', 'test/operations-auth.test.cjs'))
        copy('msa/parity/operations-auth.test.cjs', name, '/app/service/test/operations-auth.test.cjs')
        complete(name)
        spec = importlib.util.spec_from_file_location('app_release', ROOT / 'msa/deploy/app-release.py')
        release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(release)
        # Run the real deployment probe against the production image and its DB readiness route.
        release.kube = lambda *args: run('docker', 'exec', RUN + '-operations-app',
                                        *args[args.index('--') + 1:], label='deployment-probe')
        release.probe('operations', [
            {'kind': 'Deployment', 'spec': {'template': {'spec': {'containers': [
                {'readinessProbe': {'httpGet': {'path': '/operations/health/ready'}}}]}}}},
            {'kind': 'Service', 'spec': {'ports': [{'name': 'http', 'port': 3005}]}},
        ])
        report['passed'] = True
    finally:
        for kind, name in reversed(resources):
            result = subprocess.run(['docker', kind, 'inspect', name], capture_output=True, text=True)
            if result.returncode:
                continue  # A failed image build may not have created its image.
            item = json.loads(result.stdout)[0]
            labels = item.get('Config', {}).get('Labels') if kind != 'network' else item.get('Labels')
            if not labels or labels.get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of unowned resource: ' + name)
            if kind == 'container' and name.endswith('-app'):
                result = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
                (LOGS / (name + '.log')).write_text(result.stdout + result.stderr, encoding='utf-8')
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name, label=name + '-cleanup')
        (LOGS / 'verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
