"""Run HTTP/transaction tests on disposable Docker resources, without host ports."""
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
RUN = 'dva-events-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN


def run(*args, capture=False):
    try:
        result = subprocess.run(args, text=True, encoding='utf-8',
                                stdout=subprocess.PIPE if capture else None, timeout=600)
    except subprocess.TimeoutExpired:
        raise RuntimeError(f'{args[0]} {args[1]} timed out') from None
    if result.returncode:
        raise RuntimeError(f'{args[0]} {args[1]} failed with exit {result.returncode}')
    return result.stdout.strip() if capture else None


def main():
    resources = []
    password = uuid.uuid4().hex
    try:
        run('docker', 'build', '--label', LABEL, '-t', RUN, str(Path(__file__).parent))
        resources.append(('image', RUN))
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN)
        resources.append(('network', RUN))
        run('docker', 'run', '-d', '--name', RUN, '--label', LABEL, '--network', RUN,
            '--network-alias', 'events-db', '--tmpfs', '/var/lib/postgresql/data',
            '-e', 'POSTGRES_USER=event_test', '-e', 'POSTGRES_PASSWORD=' + password,
            '-e', 'POSTGRES_DB=postgres', 'postgres:17.11-bookworm')
        resources.append(('container', RUN))
        for _ in range(60):
            ready = subprocess.run(['docker', 'exec', RUN, 'pg_isready', '-U', 'event_test'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Disposable event PostgreSQL did not become ready')
        for database in ('events_sender_test', 'events_receiver_test'):
            run('docker', 'exec', RUN, 'psql', '-X', '-U', 'event_test', '-d', 'postgres',
                '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE ' + database)
        test_container = RUN + '-test'
        # This private network has no published ports; only this test client can reach these DBs.
        run('docker', 'create', '--name', test_container, '--label', LABEL, '--network', RUN,
            '-e', 'NODE_ENV=test', '-e', 'PGHOST=events-db', '-e', 'PGUSER=event_test', '-e', 'PGPASSWORD=' + password,
            '-e', 'DVA_CHANGELOG_ROOT=/changelog', RUN, 'sh', '-c',
            'node --test test/parcel-drafts.test.cjs && npm run test:integration && node --test /parity/inventory.test.cjs /parity/final-contract.test.cjs')
        resources.append(('container', test_container))
        run('docker', 'cp', str(ROOT / 'msa/liquibase/changelog') + '/.', test_container + ':/changelog')
        run('docker', 'cp', str(ROOT / 'msa/parity') + '/.', test_container + ':/parity')
        run('docker', 'cp', str(ROOT / 'backend'), test_container + ':/backend')
        # Copy only reference source; it remains unchanged and outside the installed package.
        run('docker', 'start', '--attach', test_container)
        code = run('docker', 'inspect', test_container, '--format', '{{.State.ExitCode}}', capture=True)
        if code != '0':
            raise RuntimeError('Event integration tests failed: ' + code)
    finally:
        for kind, name in reversed(resources):
            field = '{{index .Config.Labels "dva.test-run"}}' if kind == 'container' else '{{index .Labels "dva.test-run"}}'
            if kind == 'image':
                field = '{{index .Config.Labels "dva.test-run"}}'
            owner = run('docker', kind, 'inspect', name, '--format', field, capture=True)
            if owner != RUN:
                raise RuntimeError('Refusing cleanup of unowned Docker resource: ' + name)
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name)


if __name__ == '__main__':
    main()
