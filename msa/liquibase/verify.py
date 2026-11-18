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
    for service, tables, fks in [('customer',9,9),('order',11,3),('consultation',12,9),('delivery',4,1),('operations',17,8)]:
        db = service + '_db'
        sql('postgres', f'CREATE ROLE {service}_app LOGIN;\nCREATE DATABASE {db} OWNER {service}_app;\nREVOKE ALL ON DATABASE {db} FROM PUBLIC;', service+'-setup')
        lb(service, db, 'validate', service+'-validate')
        lb(service, db, 'update-sql', service+'-preview')
        before = sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", service+'-preview-no-tables')
        assert before == '0', before
        lb(service, db, 'update', service+'-update')
        catalog = sql(db, "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock')), (SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace), (SELECT count(*) FROM databasechangelog);", service+'-catalog')
        changesets = {'customer': 11, 'operations': 14, 'consultation': 12, 'order': 7, 'delivery': 3}[service]
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
            assert sql(db, "SELECT indisvalid AND pg_get_expr(indpred,indrelid)='(delivered_at IS NULL)' AND pg_get_indexdef(indexrelid,1,true)='outbox_seq' FROM pg_index WHERE indexrelid='public.outbox_pending_order_idx'::regclass;", 'customer-outbox-pending-index') == 't'
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
    db = 'customer_payment_upgrade_db'
    sql('postgres', f'CREATE DATABASE {db} OWNER customer_app;', 'member-payment-upgrade-setup')
    lb('customer', db, 'update-count', 'member-payment-upgrade-baseline', extra=('--count=7',))
    sql(db, """INSERT INTO organizations(name,status) VALUES('existing company','ACTIVE');
      INSERT INTO customers(name,phone_number,status) VALUES('one','01012345001','ACTIVE'),('two','01012345002','ACTIVE'),('three','01012345003','ACTIVE');
      INSERT INTO departments(organization_seq,name,group_billing_enabled) VALUES(1,'enabled',true),(1,'disabled',false);
      INSERT INTO memberships(customer_seq,organization_seq,department_seq,employee_no,role,status)
        VALUES(1,1,1,'1','MEMBER','ACTIVE'),(2,1,2,'2','MEMBER','INACTIVE'),(3,1,NULL,'3','MEMBER','ACTIVE');""",
        'member-payment-upgrade-fixture', 'customer_app')
    history = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'member-payment-upgrade-history')
    migration = (BASE / 'changelog/customer/008-member-payment-policy.sql').read_text(encoding='utf-8')
    run(['docker', 'exec', '-i', name, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1',
         '-U', 'customer_app', '-d', db], 'member-payment-atomic-failure',
        'BEGIN;\n' + migration + '\nSELECT 1/0;\nCOMMIT;', failure=True)
    assert sql(db, """SELECT
      (SELECT count(*) FROM information_schema.columns WHERE table_name='memberships' AND column_name IN ('monthly_billing_enabled','group_billing_enabled')),
      (SELECT column_default FROM information_schema.columns WHERE table_name='organizations' AND column_name='monthly_billing_enabled'),
      (SELECT count(*) FROM memberships);""", 'member-payment-atomic-preserved') == '0|false|3'
    lb('customer', db, 'update', 'member-payment-upgrade-current')
    assert sql(db, """SELECT string_agg(membership_seq||':'||monthly_billing_enabled||':'||group_billing_enabled,',' ORDER BY membership_seq) FROM memberships;
      SELECT monthly_billing_enabled FROM organizations WHERE organization_seq=1;
      INSERT INTO organizations(name,status) VALUES('new company','ACTIVE') RETURNING monthly_billing_enabled;""",
        'member-payment-upgrade-values', 'customer_app') == '1:true:true,2:true:false,3:true:false\nf\nt\nINSERT 0 1'
    assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog WHERE orderexecuted<=7 ORDER BY orderexecuted;', 'member-payment-upgrade-history-preserved') == history
    db = 'admin_role_upgrade_db'
    sql('postgres', f'CREATE DATABASE {db} OWNER operations_app;', 'admin-role-upgrade-setup')
    lb('operations', db, 'update-count', 'admin-role-upgrade-baseline', extra=('--count=12',))
    sql(db, """INSERT INTO admin_users(login_id,name,password_hash,role,status,created_at,last_login_at,deleted_at)
      SELECT 'legacy-role-'||n,'private-name-'||n,'unchanged-password-'||n,
        CASE WHEN n<=4 THEN 'SUPERVISOR' WHEN n=5 THEN 'OPERATOR' ELSE 'SYSTEM_ADMIN' END,
        CASE WHEN n=2 THEN 'PENDING' WHEN n=3 THEN 'INACTIVE' ELSE 'ACTIVE' END,
        '2020-01-01Z','2025-02-03Z',CASE WHEN n=4 THEN '2026-01-01Z'::timestamptz END
      FROM generate_series(1,6) n;
      INSERT INTO admin_sessions(session_token_hash,admin_user_seq,created_at,expires_at)
      SELECT lpad(n::text,64,'0'),n,'2026-11-01Z','2026-11-01T09:00:00Z' FROM generate_series(1,6) n;""",
        'admin-role-upgrade-fixture', 'operations_app')
    snapshot = """SELECT jsonb_build_object(
      'admins',(SELECT jsonb_agg(to_jsonb(a) ORDER BY admin_user_seq) FROM admin_users a),
      'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY admin_user_seq) FROM admin_sessions s),
      'audits',(SELECT jsonb_agg(to_jsonb(a) ORDER BY audit_log_seq) FROM audit_logs a));"""
    before = json.loads(sql(db, snapshot, 'admin-role-upgrade-before'))
    history = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'admin-role-upgrade-history')
    sql(db, """CREATE FUNCTION reject_role_migration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='ADMIN_ACCESS_CHANGED' AND NEW.target_seq=2 THEN RAISE EXCEPTION 'private migration audit failure'; END IF;
      RETURN NEW; END $$; CREATE TRIGGER reject_role_migration_audit BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION reject_role_migration_audit();""", 'admin-role-audit-failure-setup', 'operations_app')
    lb('operations', db, 'update', 'admin-role-audit-failure', failure=True)
    assert json.loads(sql(db, snapshot, 'admin-role-audit-failure-preserved')) == before
    assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'admin-role-failure-history-preserved') == history
    sql(db, 'DROP TRIGGER reject_role_migration_audit ON audit_logs; DROP FUNCTION reject_role_migration_audit();', 'admin-role-audit-failure-cleanup', 'operations_app')
    lb('operations', db, 'update', 'admin-role-upgrade-current')
    after = json.loads(sql(db, snapshot, 'admin-role-upgrade-after'))
    assert after['sessions'] == before['sessions']
    assert after['admins'] == [{**row, 'role': 'OPERATOR' if row['role']=='SUPERVISOR' else row['role']} for row in before['admins']]
    assert len(after['audits']) == 4
    assert len({row['request_id'] for row in after['audits']}) == 1
    assert uuid.UUID(after['audits'][0]['request_id']).version == 4
    for target, row in enumerate(after['audits'], 1):
        assert row['actor_type']=='SYSTEM' and row['actor_seq'] is None
        assert row['action']=='ADMIN_ACCESS_CHANGED' and row['target_type']=='ADMIN_USER' and row['target_seq']==target
        assert row['result']=='SUCCESS' and row['metadata']=={}
        assert row['actor_name'] is None and row['target_admin_name'] is None
    assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog WHERE orderexecuted<=12 ORDER BY orderexecuted;', 'admin-role-upgrade-history-preserved') == history
    lb('operations', db, 'update', 'admin-role-upgrade-repeat')
    assert json.loads(sql(db, snapshot, 'admin-role-upgrade-no-duplicate')) == after
    run(['docker','exec','-i',name,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U','operations_app','-d',db],
        'admin-role-legacy-value-rejected', "UPDATE admin_users SET role='SUPERVISOR' WHERE admin_user_seq=1;", failure=True)
    assert json.loads(sql(db, snapshot, 'admin-role-invalid-value-preserved')) == after
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
