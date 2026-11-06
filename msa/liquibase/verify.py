"""Integration check on a disposable Docker PostgreSQL 17, without host ports."""
import json
from pathlib import Path
import subprocess
import time
import uuid
import os
import re
import shutil

BASE = Path(__file__).resolve().parent
SOURCE = BASE / 'tests'
IMAGE = os.environ.get('DB_IMAGE', 'dva-liquibase:5.0.4-pg42.7.14')
name = 'dva-lb-test-' + uuid.uuid4().hex[:10]
logs = BASE / 'verification-logs'
logs.mkdir(exist_ok=True)
report = {'passed': False, 'checks': [], 'postgres': '17.11', 'liquibase': '5.0.4'}
report['image'] = IMAGE

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

    checks = {'customer': 'customer-check.sql', 'order': 'order-workflow-check.sql', 'consultation': 'consultation-pbx-check.sql',
              'delivery': 'delivery-workflow-check.sql', 'operations': 'operations-check.sql'}
    for service, tables, fks in [('customer',8,7),('order',4,1),('consultation',10,9),('delivery',4,1),('operations',16,8)]:
        db = service + '_db'
        sql('postgres', f'CREATE ROLE {service}_app LOGIN;\nCREATE DATABASE {db} OWNER {service}_app;\nREVOKE ALL ON DATABASE {db} FROM PUBLIC;', service+'-setup')
        lb(service, db, 'validate', service+'-validate')
        lb(service, db, 'update-sql', service+'-preview')
        before = sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", service+'-preview-no-tables')
        assert before == '0', before
        lb(service, db, 'update', service+'-update')
        catalog = sql(db, "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock')), (SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace), (SELECT count(*) FROM databasechangelog);", service+'-catalog')
        changesets = {'customer': 7, 'operations': 9, 'consultation': 7}.get(service, 2)
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
    # Upgrade a DB with 001 already applied. Each incompatible-data case must
    # halt without recording 002 or changing the original data/schema.
    for service in ('customer', 'operations'):
        db = service + '_upgrade_db'
        sql('postgres', f'CREATE DATABASE {db} OWNER {service}_app;', service+'-upgrade-setup')
        lb(service, db, 'update-count', service+'-baseline', extra=('--count=1',))
        baseline = sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', service+'-baseline-history')
        assert sql(db, 'SELECT count(*) FROM databasechangelog;', service+'-baseline-count') == '1'
        approved = preview_fingerprint(service, db, service+'-upgrade-preview')
        output = ci_command(service, db, 'apply', service+'-wrong-approval-rejected', '0'*64, failure=True)
        assert 'Pending changes changed after preview' in output, output
        assert sql(db, 'SELECT count(*) FROM databasechangelog;', service+'-wrong-approval-no-update') == '1'
        if service == 'customer':
            cases = [
                ('member', "INSERT INTO customers(name,phone_number,status) VALUES('test','01099999999','ACTIVE'); INSERT INTO organizations(name,status) VALUES('test','ACTIVE'); INSERT INTO memberships(customer_seq,organization_seq,status) SELECT customer_seq,organization_seq,'ACTIVE' FROM customers CROSS JOIN organizations;",
                 'SELECT count(*) FROM memberships;', 'DELETE FROM memberships; DELETE FROM customers; DELETE FROM organizations;'),
                ('customer-status', "INSERT INTO customers(name,phone_number,status) VALUES('test','01099999999','SUSPENDED');",
                 "SELECT count(*) FROM customers WHERE status='SUSPENDED';", 'DELETE FROM customers;'),
                ('organization-status', "INSERT INTO organizations(name,status) VALUES('test','SUSPENDED');",
                 "SELECT count(*) FROM organizations WHERE status='SUSPENDED';", 'DELETE FROM organizations;'),
            ]
        else:
            cases = [('admin-status', "INSERT INTO admin_users(login_id,password_hash,role,status) VALUES('test','not-a-login','OPERATOR','INACTIVE');",
                      "SELECT count(*) FROM admin_users WHERE status='INACTIVE';", 'DELETE FROM admin_users;')]
        for case, seed, preserved, cleanup in cases:
            label = service+'-guard-'+case
            sql(db, seed, label+'-seed', service+'_app')
            output = lb(service, db, 'update', label+'-rejected', failure=True)
            assert 'precondition' in output.lower(), output
            assert sql(db, preserved, label+'-data-preserved') == '1'
            assert sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', label+'-history-preserved') == baseline
            sql(db, cleanup, label+'-cleanup', service+'_app')

        # Inject a late failure into 002 only; 001 must remain applied and the
        # added column/changed status constraint must roll back atomically.
        upgrade_root = logs / ('atomicity-002-'+service)
        target = upgrade_root / service
        target.mkdir(parents=True, exist_ok=True)
        shutil.copytree(BASE / 'changelog', upgrade_root, dirs_exist_ok=True)
        second = '002-employee-no-and-status.sql' if service == 'customer' else '002-admin-status.sql'
        for filename in ('db.changelog.xml', '001-initial.sql', second):
            content = (BASE / 'changelog' / service / filename).read_text(encoding='utf-8')
            if filename == second:
                content += '\nSELECT 1 / 0;\n'
            (target / filename).write_text(content, encoding='utf-8')
        output = lb(service, db, 'update', service+'-002-atomic-failure', failure=True, changelog_root=upgrade_root)
        assert 'division by zero' in output.lower(), output
        assert sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', service+'-002-history-rolled-back') == baseline
        if service == 'customer':
            assert sql(db, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='memberships' AND column_name='employee_no';", service+'-002-column-rolled-back') == '0'
            restored = "SELECT count(*) FROM pg_constraint WHERE conrelid IN ('customers'::regclass,'organizations'::regclass) AND pg_get_constraintdef(oid) LIKE '%SUSPENDED%';"
            expected = '2'
        else:
            restored = "SELECT count(*) FROM pg_constraint WHERE conrelid='admin_users'::regclass AND conname='admin_users_status_check' AND pg_get_constraintdef(oid) LIKE '%INACTIVE%';"
            expected = '1'
        assert sql(db, restored, service+'-002-constraints-rolled-back') == expected
        output = ci_command(service, db, 'apply', service+'-upgrade', approved)
        assert f'DVA_MIGRATION_COMPLETE={service}' in output, output
        assert sql(db, 'SELECT count(*) FROM databasechangelog;', service+'-upgrade-count') == ('9' if service == 'operations' else '7')
        assert sql(db, "SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog WHERE id='001-initial';", service+'-001-unchanged') == baseline
        sql(db, (SOURCE / checks[service]).read_text(encoding='utf-8'), service+'-upgrade-workflow', service+'_app')
        output = ci_command(service, db, 'apply', service+'-stale-approval-rejected', approved, failure=True)
        assert 'Pending changes changed after preview' in output, output
    # Upgrade every previously supported schema without losing pending message IDs/payloads.
    for service in ('customer', 'operations', 'order', 'consultation', 'delivery'):
        db = service + '_events_upgrade_db'
        sql('postgres', f'CREATE DATABASE {db} OWNER {service}_app;', service+'-events-setup')
        previous_count = 2 if service in ('customer', 'operations') else 1
        lb(service, db, 'update-count', service+'-events-baseline', extra=(f'--count={previous_count}',))
        baseline = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', service+'-events-history-before')
        if service == 'customer':
            sql(db, "INSERT INTO customers(name,phone_number,status) VALUES('upgrade','01099999991','ACTIVE');", service+'-events-seed', service+'_app')
        else:
            sql(db, "INSERT INTO outbox_events(event_id,destination,event_type,aggregate_seq,payload) VALUES('00000000-0000-4000-8000-000000000001','delivery','OrderAccepted',1,'{\"legacy\":true}');", service+'-events-seed', service+'_app')
        if service in ('customer', 'order'):
            failing = logs / ('atomicity-events-' + service)
            shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
            shared_sql = failing / 'shared/001-event-transport.sql'
            shared_sql.write_text(shared_sql.read_text(encoding='utf-8') + '\nSELECT 1 / 0;\n', encoding='utf-8')
            output = lb(service, db, 'update', service+'-events-atomic-failure', failure=True, changelog_root=failing)
            assert 'division by zero' in output.lower(), output
            assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', service+'-events-history-rolled-back') == baseline
            assert sql(db, "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='outbox_events' AND column_name='outbox_seq';", service+'-events-columns-rolled-back') == '0'
            if service == 'customer':
                assert sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('outbox_events','inbox_events');", service+'-events-tables-rolled-back') == '0'
        lb(service, db, 'update', service+'-events-upgrade')
        assert sql(db, f'SELECT id,md5sum,dateexecuted FROM databasechangelog WHERE orderexecuted<={previous_count} ORDER BY orderexecuted;', service+'-events-old-history-preserved') == baseline
        if service == 'customer':
            assert sql(db, "SELECT count(*) FROM customers WHERE phone_number='01099999991';", service+'-events-business-preserved') == '1'
        else:
            assert sql(db, "SELECT count(*) FROM outbox_events WHERE event_id='00000000-0000-4000-8000-000000000001' AND payload='{\"legacy\":true}'::jsonb AND delivered_at IS NULL AND attempt_count=0 AND outbox_seq IS NOT NULL AND next_attempt_at IS NOT NULL;", service+'-events-pending-preserved') == '1'
    # Nameless legacy accounts must halt the new auth schema without rewriting identity/data.
    sql('postgres', 'CREATE DATABASE operations_auth_upgrade_db OWNER operations_app;', 'operations-auth-setup')
    lb('operations', 'operations_auth_upgrade_db', 'update-count', 'operations-auth-baseline', extra=('--count=3',))
    sql('operations_auth_upgrade_db', "INSERT INTO admin_users(login_id,password_hash,role,status) VALUES('legacy','preserved-hash','OPERATOR','ACTIVE');", 'operations-auth-legacy-seed', 'operations_app')
    output = lb('operations', 'operations_auth_upgrade_db', 'update', 'operations-auth-nameless-rejected', failure=True)
    assert 'Legacy administrator display names are unavailable' in output, output
    assert sql('operations_auth_upgrade_db', "SELECT login_id,password_hash FROM admin_users;", 'operations-auth-legacy-preserved') == 'legacy|preserved-hash'
    assert sql('operations_auth_upgrade_db', "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_users' AND column_name='name';", 'operations-auth-no-partial-column') == '0'
    assert sql('operations_auth_upgrade_db', 'SELECT count(*) FROM databasechangelog;', 'operations-auth-no-partial-history') == '3'
    sql('operations_auth_upgrade_db', "DELETE FROM admin_users WHERE login_id='legacy';", 'operations-auth-test-fixture-cleanup', 'operations_app')
    failing = logs / 'atomicity-operations-auth'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    auth_sql = failing / 'operations/004-admin-auth-audit.sql'
    auth_sql.write_text(auth_sql.read_text(encoding='utf-8') + '\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('operations', 'operations_auth_upgrade_db', 'update', 'operations-auth-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql('operations_auth_upgrade_db', "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_users' AND column_name IN ('name','deleted_at');", 'operations-auth-atomic-columns') == '0'
    assert sql('operations_auth_upgrade_db', "SELECT to_regclass('admin_sessions') IS NULL;", 'operations-auth-atomic-sessions') == 't'
    assert sql('operations_auth_upgrade_db', 'SELECT count(*) FROM databasechangelog;', 'operations-auth-atomic-history') == '3'
    lb('operations', 'operations_auth_upgrade_db', 'update', 'operations-auth-upgrade')
    # Upgrade a populated 003 DB without inventing legacy dates, addresses or departments.
    sql('postgres', 'CREATE DATABASE customer_reads_upgrade_db OWNER customer_app;', 'customer-reads-setup')
    db = 'customer_reads_upgrade_db'
    lb('customer', db, 'update-count', 'customer-reads-baseline', extra=('--count=3',))
    sql(db, """INSERT INTO customers(name,phone_number,status) VALUES('legacy customer','01080000001','ACTIVE');
        INSERT INTO organizations(name,status) VALUES('legacy company','ACTIVE');
        INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES(1,1,'0001','ORG_ADMIN','ACTIVE');
        INSERT INTO personal_pins(customer_seq,label,address_data,version) VALUES(1,'legacy PIN',
          '{"name":"Receiver","phoneNumber":"01080000001","roadAddress":"Road","jibunAddress":"Lot","dongName":"Dong","postalCode":"01234","latitude":37,"longitude":127}',7);
        INSERT INTO outbox_events(destination,event_type,aggregate_seq,payload) VALUES('operations','CustomerCreated',1,'{"legacy":true}');""", 'customer-reads-legacy-seed', 'customer_app')
    preserved = """SELECT jsonb_build_object(
        'customers',(SELECT jsonb_agg(jsonb_build_array(customer_seq,name,phone_number,status)) FROM customers),
        'organizations',(SELECT jsonb_agg(jsonb_build_array(organization_seq,name,status)) FROM organizations),
        'memberships',(SELECT jsonb_agg(jsonb_build_array(membership_seq,customer_seq,organization_seq,employee_no,role,status)) FROM memberships),
        'pins',(SELECT jsonb_agg(jsonb_build_array(personal_pin_seq,customer_seq,label,address_data,version)) FROM personal_pins),
        'outbox',(SELECT jsonb_agg(to_jsonb(e)) FROM outbox_events e));"""
    legacy = sql(db, preserved, 'customer-reads-legacy-before')
    failing = logs / 'atomicity-customer-reads'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    read_sql = failing / 'customer/004-customer-reads.sql'
    read_sql.write_text(read_sql.read_text(encoding='utf-8')+'\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('customer', db, 'update', 'customer-reads-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, preserved, 'customer-reads-atomic-data') == legacy
    assert sql(db, "SELECT to_regclass('departments') IS NULL AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='address_data');", 'customer-reads-atomic-schema') == 't'
    assert sql(db, 'SELECT count(*) FROM databasechangelog;', 'customer-reads-atomic-history') == '3'
    lb('customer', db, 'update-count', 'customer-reads-upgrade', extra=('--count=1',))
    assert sql(db, preserved, 'customer-reads-legacy-after') == legacy
    assert sql(db, "SELECT (SELECT created_at IS NULL AND monthly_billing_enabled=false FROM organizations WHERE organization_seq=1),(SELECT address_data IS NULL AND monthly_billing_enabled=false FROM customers WHERE customer_seq=1),(SELECT department_seq IS NULL FROM memberships WHERE membership_seq=1);", 'customer-reads-unknown-not-fabricated') == 't|t|t'
    sql(db, """INSERT INTO departments(organization_seq,name) VALUES(1,'Legacy department');
        INSERT INTO company_pins(organization_seq,department_name,address_data,version) VALUES(1,' legacy department ',
          '{"name":"Receiver","phoneNumber":"01080000001","roadAddress":"Road","jibunAddress":"Lot","dongName":"Dong","postalCode":"01234","latitude":37,"longitude":127}',11);""", 'customer-writes-legacy-company-pin', 'customer_app')
    original_pins = "SELECT jsonb_agg(to_jsonb(p)) FROM company_pins p;"
    original_pin_data = sql(db, original_pins, 'customer-writes-pin-before')
    failing = logs / 'atomicity-customer-writes'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    write_sql = failing / 'customer/005-corporate-writes.sql'
    write_sql.write_text(write_sql.read_text(encoding='utf-8')+'\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('customer', db, 'update', 'customer-writes-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, original_pins, 'customer-writes-atomic-pin-data') == original_pin_data
    assert sql(db, "SELECT count(*) FROM information_schema.columns WHERE table_name='company_pins' AND column_name IN ('department_seq','deleted_at');", 'customer-writes-atomic-schema') == '0'
    assert sql(db, 'SELECT count(*) FROM databasechangelog;', 'customer-writes-atomic-history') == '4'
    lb('customer', db, 'update-count', 'customer-writes-upgrade', extra=('--count=2',))
    archive_before = sql(db, original_pins, 'company-pin-retirement-before')
    history_before = sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'company-pin-retirement-history-before')
    failing = logs / 'atomicity-company-pin-retirement'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    migration = failing / 'customer/007-retire-company-pins.sql'
    migration.write_text(migration.read_text(encoding='utf-8')+'\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('customer', db, 'update', 'company-pin-retirement-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, original_pins, 'company-pin-retirement-rollback-data') == archive_before
    assert sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'company-pin-retirement-rollback-history') == history_before
    lb('customer', db, 'update', 'company-pin-retirement-upgrade')
    assert sql(db, original_pins, 'company-pin-retirement-preserved') == archive_before
    assert sql(db, "SELECT obj_description('company_pins'::regclass) LIKE 'Retired legacy archive.%';", 'company-pin-retirement-comment') == 't'
    assert sql(db, "SELECT version=7 AND NOT address_data ?| ARRAY['latitude','longitude'] AND address_data->>'roadAddress'='Road' FROM personal_pins WHERE personal_pin_seq=1;", 'customer-writes-pin-conversion') == 't'
    assert sql(db, "SELECT version=11 AND department_seq=1 AND NOT address_data ?| ARRAY['latitude','longitude'] FROM company_pins WHERE company_pin_seq=1;", 'customer-writes-company-pin-conversion') == 't'
    # Preserve unknown legacy registration times and roll back all late 003 failures.
    db = 'consultation_pbx_upgrade_db'
    sql('postgres', f'CREATE DATABASE {db} OWNER consultation_app;', 'consultation-pbx-upgrade-setup')
    lb('consultation', db, 'update-count', 'consultation-pbx-baseline', extra=('--count=2',))
    sql(db, """INSERT INTO call_sessions(provider_call_id,caller_phone_number) VALUES('legacy-open','01012345678');
      INSERT INTO call_sessions(provider_call_id,caller_phone_number,started_at,ended_at,end_reason) VALUES('legacy-ended','01012345679','2026-10-01T00:00:00Z','2026-10-01T00:01:00Z','legacy-pbx-end');
      INSERT INTO recordings(call_session_seq,object_key) VALUES(2,'legacy/audio.mp3');
      INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES(2,1,'AI','legacy text',1);
      INSERT INTO outbox_events(destination,event_type,aggregate_seq,payload) VALUES('order','LegacyPending',2,'{}');""", 'consultation-pbx-legacy-data', 'consultation_app')
    legacy = "SELECT jsonb_agg(to_jsonb(c)) FROM call_sessions c;"
    original_calls = sql(db, legacy, 'consultation-pbx-before')
    history = sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'consultation-pbx-history-before')
    failing = logs / 'atomicity-consultation-pbx'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    migration = failing / 'consultation/003-pbx-active-calls.sql'
    migration.write_text(migration.read_text(encoding='utf-8')+'\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('consultation', db, 'update', 'consultation-pbx-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, legacy, 'consultation-pbx-atomic-data') == original_calls
    assert sql(db, "SELECT count(*) FROM pg_namespace WHERE nspname='pbx_webhooks';", 'consultation-pbx-atomic-schema') == '0'
    assert sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'consultation-pbx-atomic-history') == history
    lb('consultation', db, 'update-count', 'consultation-pbx-upgrade', extra=('--count=1',))
    assert sql(db, "SELECT count(*) FILTER(WHERE registered_at IS NULL),count(*) FILTER(WHERE incoming_at=started_at AND provider_call_id='legacy-ended'),count(*) FILTER(WHERE incoming_at IS NULL AND provider_call_id='legacy-open') FROM call_sessions;", 'consultation-pbx-no-fabricated-time') == '2|1|1'
    assert sql(db, "SELECT (SELECT object_key FROM recordings),(SELECT utterance_text FROM call_utterances),(SELECT payload::text FROM outbox_events WHERE event_type='LegacyPending'),(SELECT end_reason FROM call_sessions WHERE provider_call_id='legacy-ended');", 'consultation-pbx-related-preserved') == 'legacy/audio.mp3|legacy text|{}|legacy-pbx-end'
    assert sql(db, "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='pbx_webhooks'),(SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='pbx_webhooks'::regnamespace),(SELECT count(*) FROM databasechangelog);", 'consultation-pbx-catalog') == '1|1|3'
    # A new logical reference must preserve unknown historical customer identities.
    calls_before_customer = sql(db, legacy, 'call-customer-before')
    failing = logs / 'atomicity-call-customer'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    migration = failing / 'consultation/004-call-customer.sql'
    migration.write_text(migration.read_text(encoding='utf-8') + '\nSELECT 1 / 0;\n', encoding='utf-8')
    history = sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'call-customer-history-before')
    output = lb('consultation', db, 'update', 'call-customer-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, legacy, 'call-customer-atomic-data') == calls_before_customer
    assert sql(db, "SELECT count(*) FROM information_schema.columns WHERE table_name='call_sessions' AND column_name='customer_seq';", 'call-customer-atomic-column') == '0'
    assert sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'call-customer-atomic-history') == history
    lb('consultation', db, 'update', 'call-customer-upgrade')
    assert sql(db, "SELECT jsonb_agg(to_jsonb(c)-'customer_seq') FROM call_sessions c;", 'call-customer-preserved') == calls_before_customer
    assert sql(db, 'SELECT count(*) FILTER(WHERE customer_seq IS NULL),count(*) FROM call_sessions;', 'call-customer-no-invented-ref') == '2|2'
    sql(db, 'UPDATE call_sessions SET customer_seq=17 WHERE call_session_seq=1;', 'call-customer-logical-ref', 'consultation_app')
    sql(db, "DO $$ BEGIN BEGIN UPDATE call_sessions SET customer_seq=0 WHERE call_session_seq=1; RAISE EXCEPTION 'invalid customer reference accepted'; EXCEPTION WHEN check_violation THEN NULL; END; END $$;", 'call-customer-invalid-ref', 'consultation_app')

    db = 'consultation_audit_upgrade_db'
    sql('postgres', f'CREATE DATABASE {db} OWNER operations_app;', 'consultation-audit-setup')
    lb('operations', db, 'update-count', 'consultation-audit-baseline', extra=('--count=5',))
    sql(db, "INSERT INTO customer_audit_preparations(event_id,transaction_id,audit) VALUES('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','{\"legacy\":true}');", 'consultation-audit-legacy-seed', 'operations_app')
    prepared = sql(db, 'SELECT row_to_json(p)::text FROM customer_audit_preparations p;', 'consultation-audit-before')
    history = sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'consultation-audit-history-before')
    failing = logs / 'atomicity-consultation-audit'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    migration = failing / 'operations/006-consultation-audit.sql'
    migration.write_text(migration.read_text(encoding='utf-8') + '\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('operations', db, 'update', 'consultation-audit-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, 'SELECT row_to_json(p)::text FROM customer_audit_preparations p;', 'consultation-audit-atomic-data') == prepared
    assert sql(db, "SELECT to_regclass('consultation_audit_preparations') IS NULL;", 'consultation-audit-atomic-table') == 't'
    assert sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'consultation-audit-atomic-history') == history
    lb('operations', db, 'update', 'consultation-audit-upgrade')
    assert sql(db, 'SELECT row_to_json(p)::text FROM customer_audit_preparations p;', 'consultation-audit-preserved') == prepared
    assert sql(db, 'SELECT count(*) FROM consultation_audit_preparations;', 'consultation-audit-empty') == '0'
    db = 'context_pin_upgrade_db'
    sql('postgres', f'CREATE DATABASE {db} OWNER customer_app;', 'context-pin-setup')
    lb('customer', db, 'update-count', 'context-pin-baseline', extra=('--count=5',))
    sql(db, """INSERT INTO customers(name,phone_number,status) VALUES('legacy owner','01080000002','ACTIVE');
      INSERT INTO personal_pins(customer_seq,label,address_data,version) VALUES(1,'legacy pin',
      '{"name":"Receiver","phoneNumber":"01080000002","roadAddress":"Road","jibunAddress":"Lot","dongName":"Dong","postalCode":"01234"}',17);""", 'context-pin-seed', 'customer_app')
    pin_before = sql(db, 'SELECT to_jsonb(p)::text FROM personal_pins p;', 'context-pin-before')
    history = sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'context-pin-history-before')
    failing = logs / 'atomicity-context-pin'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    migration = failing / 'customer/006-context-pins.sql'
    migration.write_text(migration.read_text(encoding='utf-8') + '\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('customer', db, 'update', 'context-pin-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, 'SELECT to_jsonb(p)::text FROM personal_pins p;', 'context-pin-atomic-data') == pin_before
    assert sql(db, "SELECT count(*) FROM information_schema.columns WHERE table_name='personal_pins' AND column_name='deleted_at';", 'context-pin-atomic-column') == '0'
    assert sql(db, 'SELECT id,author,md5sum FROM databasechangelog ORDER BY orderexecuted;', 'context-pin-atomic-history') == history
    lb('customer', db, 'update', 'context-pin-upgrade')
    assert sql(db, "SELECT (to_jsonb(p)-'deleted_at')::text FROM personal_pins p;", 'context-pin-preserved') == pin_before
    assert sql(db, 'SELECT deleted_at IS NULL AND version=17 AND customer_seq=1 FROM personal_pins;', 'context-pin-no-fabrication') == 't'
    sql(db, """UPDATE personal_pins SET deleted_at='2026-01-01Z' WHERE personal_pin_seq=1;
      INSERT INTO personal_pins(customer_seq,label,address_data) SELECT customer_seq,label,address_data FROM personal_pins WHERE personal_pin_seq=1;""", 'context-pin-active-reuse', 'customer_app')
    assert sql(db, 'SELECT count(*),min(version) FILTER(WHERE personal_pin_seq=1),count(*) FILTER(WHERE deleted_at IS NULL) FROM personal_pins;', 'context-pin-history-and-version') == '2|17|1'
    # 007 archives every legacy row verbatim instead of fabricating version settings.
    db = 'persona_settings_upgrade_db'
    sql('postgres', f'CREATE DATABASE {db} OWNER operations_app;', 'persona-settings-upgrade-setup')
    lb('operations', db, 'update-count', 'persona-settings-baseline', extra=('--count=6',))
    sql(db, """INSERT INTO ai_personas(code,name,voice_id,speaking_rate,turn_wait_level)
      VALUES('custom-history','Unknown historic name','actual-current-voice',1.17,'LONG');
      INSERT INTO ai_prompt_versions(ai_persona_seq,version,prompt_text,is_active,created_at)
      SELECT ai_persona_seq,1,'original prompt',false,'2001-02-03T04:05:06Z' FROM ai_personas WHERE code='custom-history';
      INSERT INTO ai_prompt_versions(ai_persona_seq,version,prompt_text,is_active,created_at)
      SELECT ai_persona_seq,2,'next prompt',true,'2002-02-03T04:05:06Z' FROM ai_personas WHERE code='custom-history';
      INSERT INTO outbox_events(destination,event_type,aggregate_seq,payload) VALUES('consultation','LegacyPending',1,'{"preserved":true}');""", 'persona-settings-legacy-seed', 'operations_app')
    legacy = lambda prefix: f"SELECT (SELECT jsonb_agg(to_jsonb(p) ORDER BY ai_persona_seq) FROM {prefix}ai_personas p),(SELECT jsonb_agg(to_jsonb(v) ORDER BY ai_prompt_version_seq) FROM {prefix}ai_prompt_versions v);"
    original_personas = sql(db, legacy(''), 'persona-settings-legacy-before')
    original_history = sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'persona-settings-history-before')
    failing = logs / 'atomicity-persona-settings'
    shutil.copytree(BASE / 'changelog', failing, dirs_exist_ok=True)
    migration = failing / 'operations/007-persona-settings.sql'
    migration.write_text(migration.read_text(encoding='utf-8')+'\nSELECT 1 / 0;\n', encoding='utf-8')
    output = lb('operations', db, 'update', 'persona-settings-atomic-failure', failure=True, changelog_root=failing)
    assert 'division by zero' in output.lower(), output
    assert sql(db, legacy(''), 'persona-settings-atomic-data') == original_personas
    assert sql(db, 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', 'persona-settings-atomic-history') == original_history
    assert sql(db, "SELECT to_regclass('legacy_ai_personas') IS NULL AND to_regclass('ai_persona_versions') IS NULL AND to_regclass('ai_persona_drafts') IS NULL;", 'persona-settings-atomic-schema') == 't'
    lb('operations', db, 'update-count', 'persona-settings-upgrade', extra=('--count=1',))
    assert sql(db, legacy('legacy_'), 'persona-settings-legacy-preserved') == original_personas
    assert sql(db, "SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog WHERE id<>'007-persona-settings' ORDER BY orderexecuted;", 'persona-settings-old-history-preserved') == original_history
    assert sql(db, "SELECT (SELECT count(*) FROM ai_personas),(SELECT count(*) FROM ai_persona_versions),(SELECT count(*) FROM ai_persona_drafts);", 'persona-settings-no-invented-settings') == '0|0|0'
    assert sql(db, "SELECT payload->>'preserved' FROM outbox_events WHERE event_type='LegacyPending' AND delivered_at IS NULL;", 'persona-settings-pending-preserved') == 'true'
    sql(db, "SELECT activate_ai_prompt(ai_prompt_version_seq) FROM legacy_ai_prompt_versions WHERE version=1 AND ai_persona_seq=(SELECT ai_persona_seq FROM legacy_ai_personas WHERE code='custom-history');", 'persona-settings-legacy-activation', 'operations_app')
    assert sql(db, "SELECT version FROM legacy_ai_prompt_versions WHERE is_active AND ai_persona_seq=(SELECT ai_persona_seq FROM legacy_ai_personas WHERE code='custom-history');", 'persona-settings-legacy-activation-result') == '1'
    sql(db, (SOURCE / 'persona-settings-check.sql').read_text(encoding='utf-8'), 'persona-settings-upgrade-workflow', 'operations_app')
    # Append-only analysis/ref changes must preserve old rows/history and roll back as a unit.
    for service, count, migration_name, test, seed, preserved, new_schema in [
        ('consultation', 4, '005-call-analysis.sql', 'call-analysis-check.sql',
         "INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at) VALUES('analysis-legacy','01012345678',NULL);",
         "SELECT jsonb_agg(to_jsonb(c) ORDER BY call_session_seq) FROM call_sessions c;",
         "SELECT to_regclass('call_analyses') IS NULL AND to_regclass('call_dashboard_metrics') IS NULL AND to_regprocedure('valid_call_latency_stats(jsonb)') IS NULL;"),
        ('operations', 7, '008-consultation-persona-references.sql', 'consultation-persona-reference-check.sql',
         "INSERT INTO consultation_audit_preparations(event_id,transaction_id,audit) VALUES('00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000012','{\"legacy\":true}');",
         "SELECT jsonb_agg(to_jsonb(p) ORDER BY event_id) FROM consultation_audit_preparations p;",
         "SELECT to_regclass('consultation_persona_references') IS NULL;"),
    ]:
        label = service+'-analysis-upgrade'
        db = service+'_analysis_upgrade_db'
        sql('postgres', f'CREATE DATABASE {db} OWNER {service}_app;', label+'-setup')
        lb(service, db, 'update-count', label+'-baseline', extra=(f'--count={count}',))
        sql(db, seed+"INSERT INTO outbox_events(destination,event_type,aggregate_seq,payload) VALUES('operations','LegacyPending',1,'{\"preserved\":true}');", label+'-seed', service+'_app')
        data = sql(db, preserved, label+'-before')
        history = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', label+'-history-before')
        failing = logs / ('atomicity-analysis-'+service)
        shutil.copytree(BASE/'changelog', failing, dirs_exist_ok=True)
        migration = failing/service/migration_name
        migration.write_text(migration.read_text(encoding='utf-8')+'\nSELECT 1 / 0;\n', encoding='utf-8')
        output = lb(service, db, 'update', label+'-failure', failure=True, changelog_root=failing)
        assert 'division by zero' in output.lower(), output
        assert sql(db, new_schema, label+'-atomic-schema') == 't'
        assert sql(db, preserved, label+'-atomic-data') == data
        assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', label+'-atomic-history') == history
        lb(service, db, 'update', label+'-apply')
        assert sql(db, preserved, label+'-preserved-data') == data
        assert sql(db, f'SELECT id,md5sum,dateexecuted FROM databasechangelog WHERE orderexecuted<={count} ORDER BY orderexecuted;', label+'-preserved-history') == history
        assert sql(db, "SELECT payload->>'preserved' FROM outbox_events WHERE event_type='LegacyPending' AND delivered_at IS NULL;", label+'-preserved-outbox') == 'true'
        if service == 'consultation':
            assert sql(db, 'SELECT count(*) FROM call_analyses;', label+'-no-invented-analysis') == '0'
        else:
            assert sql(db, 'SELECT count(*) FROM consultation_persona_references;', label+'-no-invented-reference') == '0'
        sql(db, (SOURCE/test).read_text(encoding='utf-8'), label+'-workflow', service+'_app')
    # Latest FAQ changes preserve existing content/timestamps and never guess an unknown category.
    for service, count, filename, check, seed, preserved, absent in [
        ('operations', 8, '009-faqs.sql', 'faqs-check.sql',
         "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES('faqlegacy','Legacy FAQ admin','preserved','OPERATOR','ACTIVE'); INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,created_at,updated_at) VALUES('택배 접수는 어떻게 하나요?','original answer',1,'2001-01-01Z','2002-01-01Z');",
         "SELECT to_jsonb(f)-'category'-'deleted_at' FROM faq_entries f;",
         "SELECT NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='faq_entries' AND column_name='category') AND to_regclass('faq_change_notifications') IS NULL AND to_regclass('faq_question_examples') IS NULL;"),
        ('consultation', 5, '006-call-event-sources.sql', 'call-event-sources-check.sql',
         "INSERT INTO call_sessions(provider_call_id,incoming_at) VALUES('faq-source-legacy',NULL); INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES(1,1,'CUSTOMER','preserved text',1);",
         "SELECT (SELECT jsonb_agg(to_jsonb(c)) FROM call_sessions c),(SELECT jsonb_agg(to_jsonb(u)) FROM call_utterances u);",
         "SELECT to_regclass('call_insight_events') IS NULL AND to_regclass('unanswered_questions') IS NULL;"),
    ]:
        prefix=service+'-faq-upgrade'
        db=service+'_faq_upgrade_db'
        sql('postgres',f'CREATE DATABASE {db} OWNER {service}_app;',prefix+'-setup')
        lb(service,db,'update-count',prefix+'-baseline',extra=(f'--count={count}',))
        sql(db,seed,prefix+'-seed',service+'_app')
        original=sql(db,preserved,prefix+'-before')
        history=sql(db,'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;',prefix+'-history')
        if service=='operations':
            sql(db,"INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq) VALUES('unknown legacy category','unmapped',1);",prefix+'-unmapped-seed',service+'_app')
            output=lb(service,db,'update',prefix+'-unmapped-rejected',failure=True)
            assert 'Unmapped FAQ' in output,output
            assert sql(db,absent,prefix+'-unmapped-schema')=='t'
            assert sql(db,'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;',prefix+'-unmapped-history')==history
            assert sql(db,"SELECT answer FROM faq_entries WHERE question='unknown legacy category';",prefix+'-unmapped-preserved')=='unmapped'
            sql(db,"DELETE FROM faq_entries WHERE question='unknown legacy category'; INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq) VALUES('택배 접수는 어떻게 하나요?','duplicate',1);",prefix+'-duplicate-seed',service+'_app')
            output=lb(service,db,'update',prefix+'-duplicate-rejected',failure=True)
            assert 'Duplicate FAQ question IDs' in output,output
            assert sql(db,absent,prefix+'-duplicate-schema')=='t'
            assert sql(db,'SELECT count(*) FROM faq_entries;',prefix+'-duplicate-preserved')=='2'
            sql(db,"DELETE FROM faq_entries WHERE answer='duplicate';",prefix+'-duplicate-fixture-cleanup',service+'_app')
        failing=logs/('atomicity-faq-'+service)
        shutil.copytree(BASE/'changelog',failing,dirs_exist_ok=True)
        migration=failing/service/filename
        migration.write_text(migration.read_text(encoding='utf-8')+'\nSELECT 1 / 0;\n',encoding='utf-8')
        output=lb(service,db,'update',prefix+'-late-failure',failure=True,changelog_root=failing)
        assert 'division by zero' in output.lower(),output
        assert sql(db,absent,prefix+'-atomic-schema')=='t'
        assert sql(db,preserved,prefix+'-atomic-data')==original
        assert sql(db,'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;',prefix+'-atomic-history')==history
        lb(service,db,'update',prefix+'-apply')
        assert sql(db,preserved,prefix+'-data-preserved')==original
        assert sql(db,f'SELECT id,md5sum,dateexecuted FROM databasechangelog WHERE orderexecuted<={count} ORDER BY orderexecuted;',prefix+'-history-preserved')==history
        if service=='operations':
            assert sql(db,"SELECT category FROM faq_entries;",prefix+'-verified-category')=='접수'
            assert sql(db,'SELECT (SELECT count(*) FROM faq_change_notifications),(SELECT count(*) FROM faq_question_examples);',prefix+'-no-invented-history')=='0|0'
        else:
            assert sql(db,'SELECT (SELECT count(*) FROM call_insight_events),(SELECT count(*) FROM unanswered_questions);',prefix+'-no-invented-events')=='0|0'
        sql(db,(SOURCE/check).read_text(encoding='utf-8'),prefix+'-workflow',service+'_app')
    db='recording_retry_upgrade_db'
    sql('postgres',f'CREATE DATABASE {db} OWNER consultation_app;','retry-upgrade-setup')
    lb('consultation',db,'update-count','retry-upgrade-baseline',extra=('--count=6',))
    sql(db,"""INSERT INTO call_sessions(provider_call_id) VALUES('retry-upgrade');
      INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,processing_status,call_session_seq)
      SELECT s,jsonb_build_object('fixture',s),CASE WHEN s='received' THEN 'RECEIVED' WHEN s='processed' THEN 'PROCESSED' ELSE 'FAILED' END,
        CASE WHEN s='unmatched' THEN NULL ELSE 1 END FROM unnest(ARRAY['received','processed','failed','unmatched','claimed']) s;
      UPDATE pbx_webhooks.call_ended_events SET claim_id='00000000-0000-4000-8000-000000000054',claimed_until=clock_timestamp()+interval '5 minutes',last_attempt_at=clock_timestamp() WHERE recording_id='claimed';""",'retry-upgrade-seed','consultation_app')
    snapshot="SELECT jsonb_agg(to_jsonb(e)-ARRAY['attempt_count','next_attempt_at','last_error_code','requires_review'] ORDER BY recording_id) FROM pbx_webhooks.call_ended_events e;"
    before=sql(db,snapshot,'retry-upgrade-before')
    history=sql(db,'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;','retry-upgrade-history')
    failing=logs/'atomicity-recording-retry'
    shutil.copytree(BASE/'changelog',failing,dirs_exist_ok=True)
    migration=failing/'consultation/007-recording-retry.sql'
    migration.write_text(migration.read_text(encoding='utf-8')+'\nSELECT 1/0;\n',encoding='utf-8')
    output=lb('consultation',db,'update','retry-upgrade-late-failure',failure=True,changelog_root=failing)
    assert 'division by zero' in output.lower(),output
    assert sql(db,snapshot,'retry-upgrade-atomic-data')==before
    assert sql(db,"SELECT count(*) FROM information_schema.columns WHERE table_schema='pbx_webhooks' AND table_name='call_ended_events' AND column_name='requires_review';",'retry-upgrade-atomic-schema')=='0'
    assert sql(db,'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;','retry-upgrade-atomic-history')==history
    lb('consultation',db,'update','retry-upgrade-apply')
    assert sql(db,snapshot,'retry-upgrade-data-preserved')==before
    assert sql(db,"SELECT count(*) FILTER(WHERE attempt_count=0 AND next_attempt_at IS NULL),count(*) FILTER(WHERE requires_review AND last_error_code='LEGACY_FAILURE') FROM pbx_webhooks.call_ended_events;",'retry-upgrade-legacy-state')=='5|3'
    assert sql(db,'SELECT id,md5sum,dateexecuted FROM databasechangelog WHERE orderexecuted<=6 ORDER BY orderexecuted;','retry-upgrade-history-preserved')==history
    sql(db,(SOURCE/'recording-retry-check.sql').read_text(encoding='utf-8'),'retry-upgrade-checks','consultation_app')
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
