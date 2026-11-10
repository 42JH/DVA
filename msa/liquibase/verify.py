"""Integration check on a disposable Docker PostgreSQL 17, without host ports."""
import json
from pathlib import Path
import subprocess
import time
import uuid
import os
import re
import shutil
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'parity'))
from ci_images import prepared_image
from verify_order_schema import verify_order_schema
from verify_parcel_draft_schema import verify_parcel_draft_schema

BASE = Path(__file__).resolve().parent
SOURCE = BASE / 'tests'
IMAGE = os.environ.get('DB_IMAGE', 'dva-liquibase:5.0.4-pg42.7.14')
name = 'dva-lb-test-' + uuid.uuid4().hex[:10]
logs = BASE / 'verification-logs'
logs.mkdir(exist_ok=True)
report = {'passed': False, 'checks': [], 'postgres': '17.11', 'liquibase': '5.0.4'}
report['image'] = IMAGE
report['upgradeBaseline'] = '055'

def run(args, label, stdin=None, failure=False):
    # Byte input prevents Windows from rewriting SQL function/literal newlines.
    result = subprocess.run(args, input=stdin.encode('utf-8') if stdin is not None else None,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            timeout=240)
    output = result.stdout.decode('utf-8', 'replace').replace('\r\n', '\n').replace('\r', '\n')
    (logs / (label + '.log')).write_text(output, encoding='utf-8')
    if (result.returncode == 0) == failure:
        raise RuntimeError(label + ': ' + output[-5000:])
    report['checks'].append(label)
    print(label, flush=True)
    return output.strip()

def sql(db, statement, label, user='postgres'):
    return run(['docker', 'exec', '-i', name, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
                '-U', user, '-d', db], label, statement)

def lb(service, db, action, label, failure=False, extra=(), changelog_root=None):
    args = ['--network', name,
                '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{name}:5432/{db}',
                '-e', f'LIQUIBASE_COMMAND_USERNAME={service}_app',
                report['imageId'], f'--changelog-file={service}/db.changelog.xml',
                action, *extra]
    if changelog_root is None:
        return run(['docker', 'run', '--rm', *args], label, failure=failure)
    container = run(['docker', 'create', *args], label+'-create')
    try:
        # The Docker daemon may run separately from the Jenkins workspace.
        run(['docker', 'cp', str(changelog_root) + '/.',
             container + ':/liquibase/changelog/'], label+'-copy')
        return run(['docker', 'start', '--attach', container], label, failure=failure)
    finally:
        run(['docker', 'rm', '-f', container], label+'-cleanup')

def ci_command(service, db, action, label, expected='', failure=False):
    return run(['docker', 'run', '--rm', '--network', name,
                '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{name}:5432/{db}',
                '-e', f'LIQUIBASE_COMMAND_USERNAME={service}_app',
                '--entrypoint', '/bin/bash', report['imageId'], '/liquibase/ci-command.sh',
                service, action, expected], label, failure=failure)

def preview_fingerprint(service, db, label):
    output = ci_command(service, db, 'preview', label)
    found = re.findall(r'^DVA_PENDING_SHA256=([0-9a-f]{64})$', output, re.M)
    assert len(found) == 1, output
    return found[0]

network_created = pg_created = False
try:
    report['imageId'] = prepared_image('liquibase')
    if not report['imageId']:
        run(['docker', 'build', '--platform', 'linux/amd64', '-t', IMAGE, str(BASE)], 'image-build')
        report['imageId'] = run(['docker', 'image', 'inspect', IMAGE, '--format', '{{.Id}}'], 'image-id')
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

    checks = {'customer': 'customer-check.sql', 'order': 'order-storage-check.sql', 'consultation': 'consultation-pbx-check.sql',
              'delivery': 'delivery-storage-check.sql', 'operations': 'operations-check.sql'}
    for service, tables, fks in [('customer',8,7),('order',11,3),('consultation',12,9),('delivery',4,1),('operations',17,8)]:
        db = service + '_db'
        sql('postgres', f'CREATE ROLE {service}_app LOGIN;\nCREATE DATABASE {db} OWNER {service}_app;\nREVOKE ALL ON DATABASE {db} FROM PUBLIC;', service+'-setup')
        lb(service, db, 'validate', service+'-validate')
        lb(service, db, 'update-sql', service+'-preview')
        before = sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", service+'-preview-no-tables')
        assert before == '0', before
        lb(service, db, 'update', service+'-update')
        catalog = sql(db, "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock')), (SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace), (SELECT count(*) FROM databasechangelog);", service+'-catalog')
        changesets = {'customer': 7, 'operations': 11, 'consultation': 11, 'order': 5, 'delivery': 3}[service]
        assert catalog == f'{tables}|{fks}|{changesets}', catalog
        owners = sql(db, f"SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner <> '{service}_app';", service+'-owners')
        assert owners == '0', owners
        history = sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog;', service+'-history-before')
        lb(service, db, 'update', service+'-repeat')
        after = sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog;', service+'-history-after')
        assert history == after, service
        if service in checks:
            sql(db, (SOURCE / checks[service]).read_text(encoding='utf-8'), service+'-workflow', service+'_app')
        if service == 'customer':
            sql(db, (SOURCE / 'customer-reads-check.sql').read_text(encoding='utf-8'), 'customer-reads-workflow', 'customer_app')
        if service == 'operations':
            sql(db, (SOURCE / 'faqs-check.sql').read_text(encoding='utf-8'), 'faqs-workflow', 'operations_app')
            sql(db, (SOURCE / 'persona-settings-check.sql').read_text(encoding='utf-8'), 'persona-settings-workflow', 'operations_app')
            sql(db, (SOURCE / 'consultation-persona-reference-check.sql').read_text(encoding='utf-8'), 'consultation-persona-reference-workflow', 'operations_app')
            sql(db, (SOURCE / 'order-audit-check.sql').read_text(encoding='utf-8'), 'order-audit-workflow', 'operations_app')
        if service == 'consultation':
            sql(db, (SOURCE / 'recording-retry-check.sql').read_text(encoding='utf-8'), 'recording-retry-workflow', 'consultation_app')
            sql(db, (SOURCE / 'call-event-sources-check.sql').read_text(encoding='utf-8'), 'call-event-sources-workflow', 'consultation_app')
            sql(db, (SOURCE / 'call-analysis-check.sql').read_text(encoding='utf-8'), 'call-analysis-workflow', 'consultation_app')
        fingerprint = preview_fingerprint(service, db, service+'-ci-preview-current')
        output = ci_command(service, db, 'apply', service+'-ci-apply-current', fingerprint)
        assert f'DVA_MIGRATION_COMPLETE={service}' in output, output

    sql('postgres', 'CREATE DATABASE guard_db OWNER customer_app;', 'guard-setup')
    sql('guard_db', 'CREATE TABLE sentinel(id integer);', 'guard-existing', 'customer_app')
    lb('customer', 'guard_db', 'update', 'nonempty-database-rejected', failure=True)
    assert sql('guard_db', "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", 'guard-preserved') == '1'
    # An error late in the initial SQL must roll back tables and Liquibase history.
    broken = logs / 'atomicity' / 'customer'
    broken.mkdir(parents=True, exist_ok=True)
    shutil.copytree(BASE / 'changelog', broken.parent, dirs_exist_ok=True)
    for filename in ('db.changelog.xml', '001-initial.sql', '002-employee-no-and-status.sql'):
        content = (BASE / 'changelog' / 'customer' / filename).read_text(encoding='utf-8')
        if filename == '001-initial.sql':
            content += '\nSELECT 1 / 0;\n'
        (broken / filename).write_text(content, encoding='utf-8')
    sql('postgres', 'CREATE DATABASE atomic_db OWNER customer_app;', 'atomic-setup')
    failure_output = lb('customer', 'atomic_db', 'update', 'atomic-failure',
                        failure=True, changelog_root=broken.parent)
    assert 'division by zero' in failure_output.lower(), failure_output
    assert sql('atomic_db', "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock')), (SELECT count(*) FROM databasechangelog);", 'atomic-rolled-back') == '0|0'
    # Pending/stale fingerprint protection is shared by every service.
    db = 'approval_db'
    sql('postgres', 'CREATE DATABASE approval_db OWNER customer_app;', 'approval-setup')
    lb('customer', db, 'update-count', 'approval-pending-baseline', extra=('--count=1',))
    history = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'approval-history')
    approved = preview_fingerprint('customer', db, 'approval-preview')
    output = ci_command('customer', db, 'apply', 'wrong-approval-rejected', '0'*64, failure=True)
    assert 'Pending changes changed after preview' in output, output
    assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'wrong-approval-preserves-history') == history
    output = ci_command('customer', db, 'apply', 'approved-pending-apply', approved)
    assert 'DVA_MIGRATION_COMPLETE=customer' in output, output
    applied = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'approval-current-history')
    output = ci_command('customer', db, 'apply', 'stale-approval-rejected', approved, failure=True)
    assert 'Pending changes changed after preview' in output, output
    assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'stale-approval-preserves-history') == applied
    verify_order_schema(BASE, sql, report)
    verify_parcel_draft_schema(BASE, logs, sql, lb, report)
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
