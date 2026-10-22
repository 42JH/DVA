"""Integration check on a disposable Docker PostgreSQL 17, without host ports."""
import json
from pathlib import Path
import subprocess
import time
import uuid

BASE = Path(__file__).resolve().parent
SOURCE = BASE / 'tests'
IMAGE = 'dva-liquibase:5.0.4-pg42.7.14'
name = 'dva-lb-test-' + uuid.uuid4().hex[:10]
logs = BASE / 'verification-logs'
logs.mkdir(exist_ok=True)
report = {'passed': False, 'checks': [], 'postgres': '17.11', 'liquibase': '5.0.4'}

def run(args, label, stdin=None, failure=False):
    result = subprocess.run(args, input=stdin, text=True, encoding='utf-8',
                            errors='replace', stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=240)
    (logs / (label + '.log')).write_text(result.stdout, encoding='utf-8')
    if (result.returncode == 0) == failure:
        raise RuntimeError(label + ': ' + result.stdout[-5000:])
    report['checks'].append(label)
    print(label, flush=True)
    return result.stdout.strip()

def sql(db, statement, label, user='postgres'):
    return run(['docker', 'exec', '-i', name, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
                '-U', user, '-d', db], label, statement)

def lb(service, db, action, label, failure=False):
    return run(['docker', 'run', '--rm', '--network', name,
                '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{name}:5432/{db}',
                '-e', f'LIQUIBASE_COMMAND_USERNAME={service}_app',
                IMAGE, f'--changelog-file={service}/db.changelog.xml',
                action], label, failure=failure)

network_created = pg_created = False
try:
    run(['docker', 'build', '-t', IMAGE, str(BASE)], 'image-build')
    run(['docker', 'network', 'create', '--internal', name], 'network-create')
    network_created = True
    run(['docker', 'run', '-d', '--name', name, '--network', name,
         '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
         'postgres:17.11-bookworm'], 'postgres-start')
    pg_created = True
    for _ in range(60):
        ready = subprocess.run(['docker','exec',name,'pg_isready','-h','127.0.0.1','-U','postgres'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError('PostgreSQL not ready')

    checks = {'customer': 'customer-check.sql', 'order': 'order-workflow-check.sql',
              'delivery': 'delivery-workflow-check.sql', 'operations': 'operations-check.sql'}
    for service, tables, fks in [('customer',5,4),('order',4,1),('consultation',6,3),('delivery',4,1),('operations',7,3)]:
        db = service + '_db'
        sql('postgres', f'CREATE ROLE {service}_app LOGIN;\nCREATE DATABASE {db} OWNER {service}_app;\nREVOKE ALL ON DATABASE {db} FROM PUBLIC;', service+'-setup')
        lb(service, db, 'validate', service+'-validate')
        lb(service, db, 'update-sql', service+'-preview')
        before = sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", service+'-preview-no-tables')
        assert before == '0', before
        lb(service, db, 'update', service+'-update')
        catalog = sql(db, "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock')), (SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace), (SELECT count(*) FROM databasechangelog);", service+'-catalog')
        assert catalog == f'{tables}|{fks}|1', catalog
        owners = sql(db, f"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner <> '{service}_app';", service+'-owners')
        assert owners == '0', owners
        history = sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog;', service+'-history-before')
        lb(service, db, 'update', service+'-repeat')
        after = sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog;', service+'-history-after')
        assert history == after, service
        if service in checks:
            sql(db, (SOURCE / checks[service]).read_text(encoding='utf-8'), service+'-workflow', service+'_app')

    sql('postgres', 'CREATE DATABASE guard_db OWNER customer_app;', 'guard-setup')
    sql('guard_db', 'CREATE TABLE sentinel(id integer);', 'guard-existing', 'customer_app')
    lb('customer', 'guard_db', 'update', 'nonempty-database-rejected', failure=True)
    assert sql('guard_db', "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", 'guard-preserved') == '1'
    # An error late in the initial SQL must roll back tables and Liquibase history.
    broken = logs / 'atomicity' / 'customer'
    broken.mkdir(parents=True, exist_ok=True)
    for filename in ('db.changelog.xml', '001-initial.sql'):
        content = (BASE / 'changelog' / 'customer' / filename).read_text(encoding='utf-8')
        if filename.endswith('.sql'):
            content += '\nSELECT 1 / 0;\n'
        (broken / filename).write_text(content, encoding='utf-8')
    sql('postgres', 'CREATE DATABASE atomic_db OWNER customer_app;', 'atomic-setup')
    run(['docker', 'run', '--rm', '--network', name,
         '-v', str(broken.parent) + ':/liquibase/changelog:ro',
         '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{name}:5432/atomic_db',
         '-e', 'LIQUIBASE_COMMAND_USERNAME=customer_app', IMAGE,
         '--changelog-file=customer/db.changelog.xml', 'update'], 'atomic-failure', failure=True)
    assert sql('atomic_db', "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock')), (SELECT count(*) FROM databasechangelog);", 'atomic-rolled-back') == '0|0'
    report['passed'] = True
except Exception as error:
    report['error'] = str(error)
    raise
finally:
    if pg_created:
        run(['docker', 'rm', '-f', name], 'postgres-cleanup')
    if network_created:
        run(['docker', 'network', 'rm', name], 'network-cleanup')
    (BASE / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
