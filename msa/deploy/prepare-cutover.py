"""Prepare one quiescent 055 epoch; keep backups on the server, outside CI artifacts."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

KUBE = ['sudo', '-n', 'k3s', 'kubectl']
OWNERS = ('order', 'consultation')
SERVICES = ('operations', 'customer', 'consultation', 'delivery', 'order')
ROOT = Path('/home/ubuntu/msa-deploy')
QUIET_SQL = "SELECT count(*) FROM outbox_events WHERE delivered_at IS NULL;"
OUTBOX_SQL = "SELECT to_regclass('public.outbox_events') IS NOT NULL;"
EMPTY_SQL = "SELECT count(*) FROM pg_tables WHERE schemaname IN ('public','pbx_webhooks') AND tablename NOT IN ('databasechangelog','databasechangeloglock');"
CALL_SQL = """SELECT
 (SELECT count(*) FROM call_sessions WHERE registered_at IS NOT NULL AND ended_at IS NULL AND deleted_at IS NULL),
 (SELECT count(*) FROM pbx_webhooks.call_ended_events WHERE processing_status<>'PROCESSED');"""


def kube(*args, data=None, output=None, source=None, timeout=180):
    result = subprocess.run([*KUBE, *args], input=data, stdout=output or subprocess.PIPE,
                            stdin=source, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Do not echo command output containing DB contents or a Secret document.
        raise RuntimeError('055 preparation command failed: ' + args[0])
    return result.stdout.decode('utf-8').strip() if output is None else ''


def database(service):
    secret = json.loads(kube('-n', 'dva', 'get', 'secret', service + '-db', '-o', 'json'))
    values = {key: base64.b64decode(secret['data'][key], validate=True).decode('utf-8')
              for key in ('PGHOST', 'PGPORT', 'PGDATABASE')}
    if (values['PGHOST'] not in ('postgres', 'postgres.dva.svc', 'postgres.dva.svc.cluster.local')
            or values['PGPORT'] != '5432' or not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,62}', values['PGDATABASE'])):
        raise RuntimeError('055 automatic backup requires the configured in-cluster PostgreSQL')
    return values['PGDATABASE']


def pg(db, statement):
    return kube('-n', 'dva', 'exec', '-i', 'deployment/postgres', '--', 'sh', '-ceu',
                'exec psql -X -At -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d "$1"',
                '--', db, data=statement.encode('utf-8'))


def quiet(databases):
    existing = set()
    for service in SERVICES:
        present = pg(databases[service], OUTBOX_SQL)
        if present == 'f' and pg(databases[service], EMPTY_SQL) == '0':
            continue  # Fresh DBs have no business work to drain.
        if present != 't':
            raise RuntimeError('Cannot establish 055 event state: ' + service)
        existing.add(service)
        if pg(databases[service], QUIET_SQL) != '0':
            raise RuntimeError('055 waits for pending service events: ' + service)
    if 'consultation' in existing and pg(databases['consultation'], CALL_SQL) != '0|0':
        raise RuntimeError('055 waits for active calls and pending PBX work')


def get_deployments():
    document = kube('-n', 'dva', 'get', 'deployment', *OWNERS, '--ignore-not-found', '-o', 'json')
    return json.loads(document)['items'] if document else []


def stopped():
    deployments = get_deployments()
    if any(d.get('spec', {}).get('replicas', 1) != 0 or d.get('status', {}).get('replicas', 0) != 0 for d in deployments):
        return False
    return not json.loads(kube('-n', 'dva', 'get', 'pods', '-l',
                               'app in (dva-order,dva-consultation)', '-o', 'json'))['items']


def backup(db, path):
    # O_EXCL/0600 refuses overwrites and keeps retained business data out of build logs.
    with path.open('xb') as output:
        os.chmod(path, 0o600)
        kube('-n', 'dva', 'exec', 'deployment/postgres', '--', 'sh', '-ceu',
             'exec pg_dump -U "${POSTGRES_USER:-postgres}" --format=custom --dbname="$1"',
             '--', db, output=output, timeout=600)
    if path.stat().st_size == 0:
        raise RuntimeError('Empty 055 backup')
    with path.open('rb') as source:
        kube('-n', 'dva', 'exec', '-i', 'deployment/postgres', '--', 'pg_restore', '--list',
             source=source, output=subprocess.DEVNULL, timeout=180)
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def location(release):
    if not re.fullmatch(r'[0-9a-f]{40}-[0-9]+', release):
        raise ValueError('Invalid cutover release')
    path = ROOT / 'backups' / release
    if path.resolve() != path.absolute() or path.parent.is_symlink():
        raise RuntimeError('Linked backup location is forbidden')
    return path


def staged(release):
    for service in OWNERS:
        path = ROOT / 'apps' / release / service
        if path.resolve() != path.absolute() or (path / 'prepared-image.json').is_symlink():
            raise RuntimeError('Linked app preparation is forbidden')
        subprocess.run(['sha256sum', '--check', '--strict', 'SHA256SUMS'], cwd=path,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        digest = (path / 'image-id.txt').read_text().strip()
        expected = {'release': release, 'image': f'docker.io/library/dva-{service}:{release}',
                    'digest': digest, 'parcelDraftsContract': '055'}
        if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest) or json.loads((path / 'prepared-image.json').read_text()) != expected:
            raise RuntimeError('Both compatible 055 app images must be staged before stopping writers')


def prepare(release):
    path = location(release)
    if path.exists():
        raise RuntimeError('Cutover backup directory already exists; use a new build')
    staged(release)
    deployments = get_deployments()
    replicas = {d['metadata']['name']: d.get('spec', {}).get('replicas', 1) for d in deployments}
    databases = {service: database(service) for service in SERVICES}
    if len(set(databases.values())) != len(SERVICES):
        raise RuntimeError('055 service DBs must be isolated')
    quiet(databases)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(path.parent, 0o700)
    path.mkdir(mode=0o700)
    previous = {d['metadata']['name']: {'uid': d['metadata']['uid'],
                'containers': d['spec']['template']['spec']['containers']} for d in deployments}
    recovery = {'release': release, 'replicas': replicas, 'previous': previous}
    with (path / 'recovery.json').open('x', encoding='utf-8') as output:
        os.chmod(path / 'recovery.json', 0o600)
        json.dump(recovery, output)
    attempted = False
    try:
        attempted = True
        for service in replicas:
            kube('-n', 'dva', 'scale', 'deployment/' + service, '--replicas=0')
        deadline = time.monotonic() + 120
        while not stopped():
            if time.monotonic() >= deadline:
                raise RuntimeError('055 writers did not stop')
            time.sleep(1)
        # A late in-flight request must not leave work hidden in the snapshots.
        quiet(databases)
        digests = {service: backup(databases[service], path / (service + '.dump')) for service in OWNERS}
        document = {**recovery, 'databases': databases, 'sha256': digests}
        state = path / 'ready.json'
        with state.open('x', encoding='utf-8') as output:
            os.chmod(state, 0o600)
            json.dump(document, output)
    except BaseException:
        if attempted:
            restore(release)
        raise
    print('DVA_QUIESCENT_CUTOVER_READY=055')


def verify(release):
    path = location(release)
    state = path / 'ready.json'
    if state.is_symlink():
        raise RuntimeError('Linked cutover state is forbidden')
    document = json.loads(state.read_text())
    if document['release'] != release or not stopped():
        raise RuntimeError('055 preparation does not match stopped writers/current release')
    for service in OWNERS:
        dump = path / (service + '.dump')
        if dump.is_symlink() or dump.stat().st_mode & 0o077:
            raise RuntimeError('Unprotected 055 backup')
        with dump.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != document['sha256'][service]:
                raise RuntimeError('055 backup checksum mismatch')
    databases = {service: database(service) for service in SERVICES}
    if databases != document['databases']:
        raise RuntimeError('055 backup DB configuration changed')
    quiet(databases)
    print('DVA_QUIESCENT_CUTOVER_VERIFIED=055')


def restore(release):
    # An ambiguous DDL response must never resume an incompatible writer.
    namespace = json.loads(kube('get', 'namespace', 'dva', '-o', 'json'))
    if namespace.get('metadata', {}).get('annotations', {}).get('dva.ssafy.io/parcel-drafts-schema') == '055':
        raise RuntimeError('055 DDL fence is set; keep writers stopped and deploy a compatible release')
    recovery = location(release) / 'recovery.json'
    if recovery.is_symlink():
        raise RuntimeError('Linked recovery state is forbidden')
    document = json.loads(recovery.read_text())
    if document['release'] != release or set(document['replicas']) - set(OWNERS):
        raise RuntimeError('Cutover recovery state does not match this release')
    deployments = get_deployments()
    actual = {d['metadata']['name']: {'uid': d['metadata']['uid'],
              'containers': d['spec']['template']['spec']['containers']} for d in deployments}
    if actual != document['previous']:
        raise RuntimeError('Another operator changed the source deployments; refusing recovery')
    for service in document['replicas']:
        replicas = document['replicas'][service]
        if not isinstance(replicas, int) or replicas < 0:
            raise RuntimeError('Invalid previous replica count')
        kube('-n', 'dva', 'scale', 'deployment/' + service, '--replicas=' + str(replicas))
    print('DVA_QUIESCENT_CUTOVER_RESTORED=055')


if __name__ == '__main__':
    def interrupted(number, _frame):
        raise SystemExit(128 + number)
    signal.signal(signal.SIGTERM, interrupted)
    if len(sys.argv) != 3 or sys.argv[1] not in ('prepare', 'verify', 'restore'):
        raise SystemExit('Specify prepare/verify/restore RELEASE')
    {'prepare': prepare, 'verify': verify, 'restore': restore}[sys.argv[1]](sys.argv[2])
