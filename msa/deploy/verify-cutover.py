"""Real PostgreSQL dump/restore check; Kubernetes state is an isolated fixture."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('prepare-cutover.py'))
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)
RUN = 'dva-cutover-check-' + uuid.uuid4().hex[:10]
LABEL = 'dva.test-run=' + RUN


def docker(*args, data=None, source=None, output=None):
    result = subprocess.run(['docker', *args], input=data, stdin=source,
                            stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        raise RuntimeError('Fixture Docker command failed: ' + result.stderr.decode('utf-8', 'replace')[-2000:])
    return result.stdout.decode('utf-8').strip() if output is None else ''


def sql(db, statement):
    return docker('exec', '-i', RUN, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
                  '-U', 'postgres', '-d', db, data=statement.encode('utf-8'))


def main():
    network = container = False
    try:
        docker('network', 'create', '--internal', '--label', LABEL, RUN)
        network = True
        docker('run', '-d', '--name', RUN, '--label', LABEL, '--network', RUN,
               '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17.11-bookworm')
        container = True
        for _ in range(60):
            if subprocess.run(['docker', 'exec', RUN, 'pg_isready', '-U', 'postgres'], capture_output=True).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Fixture PostgreSQL not ready')
        databases = {s: s + '_cutover' for s in cutover.SERVICES}
        for db in databases.values():
            sql('postgres', 'CREATE DATABASE ' + db + ';')
            sql(db, """CREATE TABLE outbox_events(event_id uuid PRIMARY KEY,delivered_at timestamptz,payload jsonb);
                INSERT INTO outbox_events VALUES(gen_random_uuid(),now(),'{"synthetic":true}');
                CREATE TABLE backup_probe(id int PRIMARY KEY,value text,payload jsonb);
                INSERT INTO backup_probe VALUES(1,'합성 데이터','{"array":[1,null,true]}'),(2,NULL,'{}');""")
        sql(databases['consultation'], """CREATE TABLE call_sessions(registered_at timestamptz,ended_at timestamptz,deleted_at timestamptz);
            INSERT INTO call_sessions VALUES(now(),now(),NULL),(NULL,NULL,NULL);
            CREATE SCHEMA pbx_webhooks;
            CREATE TABLE pbx_webhooks.call_ended_events(processing_status text);
            INSERT INTO pbx_webhooks.call_ended_events VALUES('PROCESSED');""")
        replicas = {s: 1 for s in cutover.OWNERS}

        def kube(*args, data=None, source=None, output=None, timeout=180):
            if 'exec' in args:
                command = args[args.index('--') + 1:]
                return docker('exec', '-i', RUN, *command, data=data, source=source, output=output)
            if 'secret' in args:
                owner = args[args.index('secret') + 1].removesuffix('-db')
                return json.dumps({'data': {k: base64.b64encode(v.encode()).decode() for k, v in {
                    'PGHOST': 'postgres', 'PGPORT': '5432', 'PGDATABASE': databases[owner],
                }.items()}})
            if 'scale' in args:
                owner = next(s for s in cutover.OWNERS if 'deployment/' + s in args)
                replicas[owner] = int(args[-1].split('=')[1])
                return ''
            if 'deployment' in args:
                return json.dumps({'items': [{'metadata': {'name': s, 'uid': s},
                    'spec': {'replicas': n, 'template': {'spec': {'containers': [{'image': 'synthetic'}]}}},
                    'status': {'replicas': n}} for s, n in replicas.items()]})
            if 'pods' in args:
                return json.dumps({'items': [] if not any(replicas.values()) else [{'metadata': {}}]})
            if 'namespace' in args:
                return json.dumps({'metadata': {}})
            raise AssertionError(args)

        cutover.kube = kube
        with tempfile.TemporaryDirectory(prefix=RUN) as directory:
            cutover.ROOT = Path(directory)
            # Staging/Kubernetes rollout are covered by deployment regressions; this checks real DB bytes.
            cutover.staged = lambda _: None
            release = 'a' * 40 + '-1'
            cutover.prepare(release)
            cutover.verify(release)
            tables = 0
            for owner in cutover.OWNERS:
                restored = owner + '_restored'
                sql('postgres', 'CREATE DATABASE ' + restored + ';')
                dump = cutover.ROOT / 'backups' / release / (owner + '.dump')
                with dump.open('rb') as source:
                    docker('exec', '-i', RUN, 'pg_restore', '-U', 'postgres', '-d', restored, source=source)
                names = sql(databases[owner], "SELECT schemaname||'.'||tablename FROM pg_tables WHERE schemaname IN ('public','pbx_webhooks') ORDER BY 1;").splitlines()
                for name in names:
                    statement = 'SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),\'[]\'::jsonb) FROM ' + name + ' t;'
                    assert json.loads(sql(databases[owner], statement)) == json.loads(sql(restored, statement)), name
                    tables += 1
            sql(databases['order'], "INSERT INTO outbox_events VALUES(gen_random_uuid(),NULL,'{}');")
            try:
                cutover.verify(release)
            except RuntimeError as error:
                assert 'pending service events' in str(error), str(error)
            else:
                raise AssertionError('A late event was accepted after backup')
            print(json.dumps({'passed': True, 'backupsRestored': 2, 'tablesCompared': tables,
                              'lateEventRejected': True, 'kubernetes': 'fixture'}))
    finally:
        for kind, created in (('container', container), ('network', network)):
            if not created:
                continue
            value = json.loads(docker(kind, 'inspect', RUN))[0]
            labels = value.get('Labels') if kind == 'network' else value['Config']['Labels']
            if labels.get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of another test run')
            docker(kind, 'rm', *(['-f'] if kind == 'container' else []), RUN)


if __name__ == '__main__':
    main()
