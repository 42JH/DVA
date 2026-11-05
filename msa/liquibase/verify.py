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

    checks = {'customer': 'customer-check.sql', 'order': 'order-workflow-check.sql',
              'delivery': 'delivery-workflow-check.sql', 'operations': 'operations-check.sql'}
    for service, tables, fks in [('customer',8,7),('order',4,1),('consultation',6,3),('delivery',4,1),('operations',9,4)]:
        db = service + '_db'
        sql('postgres', f'CREATE ROLE {service}_app LOGIN;\nCREATE DATABASE {db} OWNER {service}_app;\nREVOKE ALL ON DATABASE {db} FROM PUBLIC;', service+'-setup')
        lb(service, db, 'validate', service+'-validate')
        lb(service, db, 'update-sql', service+'-preview')
        before = sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", service+'-preview-no-tables')
        assert before == '0', before
        lb(service, db, 'update', service+'-update')
        catalog = sql(db, "SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock')), (SELECT count(*) FROM pg_constraint WHERE contype='f' AND connamespace='public'::regnamespace), (SELECT count(*) FROM databasechangelog);", service+'-catalog')
        changesets = {'customer': 5, 'operations': 5}.get(service, 2)
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
        assert sql(db, 'SELECT count(*) FROM databasechangelog;', service+'-upgrade-count') == '5'
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
    lb('customer', db, 'update', 'customer-writes-upgrade')
    assert sql(db, "SELECT version=7 AND NOT address_data ?| ARRAY['latitude','longitude'] AND address_data->>'roadAddress'='Road' FROM personal_pins WHERE personal_pin_seq=1;", 'customer-writes-pin-conversion') == 't'
    assert sql(db, "SELECT version=11 AND department_seq=1 AND NOT address_data ?| ARRAY['latitude','longitude'] FROM company_pins WHERE company_pin_seq=1;", 'customer-writes-company-pin-conversion') == 't'
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
