"""Compare order reads and deletion against the unchanged monolith on five isolated PostgreSQL DBs."""
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
RUN = 'dva-order-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN
LOGS = ROOT / 'msa/liquibase/verification-logs/order'


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    resources = []
    report = {'passed': False, 'checks': [], 'environment': 'production',
              'reference': subprocess.check_output(['git', 'rev-parse', 'HEAD:backend'], cwd=ROOT, text=True).strip()}

    def run(*args, label):
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
        output = result.stdout.decode('utf-8', 'replace').replace('\r\n', '\n')
        (LOGS / (label + '.log')).write_text(output, encoding='utf-8')
        if result.returncode:
            raise RuntimeError(label + ': ' + output[-6000:])
        report['checks'].append(label)
        print(label, flush=True)
        return output.strip()

    def create(name, image, *args, command=(), network=RUN):
        run('docker', 'create', '--name', name, '--label', LABEL, '--network', network, *args, image, *command, label=name+'-create')
        resources.append(('container', name))

    def complete(name):
        run('docker', 'start', '--attach', name, label=name+'-run')
        code = run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name+'-exit')
        if code != '0':
            raise RuntimeError(name+' exited with '+code)

    password, token = uuid.uuid4().hex, uuid.uuid4().hex
    try:
        images = {}
        for side, path, target in (
            ('order-checks', 'msa/services/order', 'checks'), ('order', 'msa/services/order', None),
            ('customer', 'msa/services/customer', None), ('consultation', 'msa/services/consultation', None),
            ('operations', 'msa/services/operations', None), ('monolith-checks', 'backend', 'checks'),
            ('monolith', 'backend', None), ('liquibase', 'msa/liquibase', None),
        ):
            image = RUN+'-'+side
            resources.append(('image', image))
            context = ['-f', str(ROOT/path/'Dockerfile'), str(ROOT/'msa')] if path.startswith('msa/services/') else [str(ROOT/path)]
            run('docker', 'build', '--label', LABEL, '-t', image, *(['--target', target] if target else []), *context, label=side+'-build')
            images[side] = image
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        for side in ('monolith', 'operations', 'customer', 'consultation', 'order'):
            name = RUN+'-'+side+'-db'
            create(name, 'postgres:17.11-bookworm', '--network-alias', side+'-db', '--tmpfs', '/var/lib/postgresql/data',
                   '-e', 'POSTGRES_USER='+side+'_app', '-e', 'POSTGRES_PASSWORD='+password, '-e', 'POSTGRES_DB=dva_webhook_test')
            run('docker', 'start', name, label=side+'-db-start')
            for _ in range(60):
                if subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', side+'_app'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError(side+' DB did not become ready')
            name = RUN+'-'+side+'-schema'
            if side == 'monolith':
                create(name, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_NAME=dva_webhook_test',
                       '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PGHOST=monolith-db', '-e', 'PGUSER=monolith_app',
                       '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
                       command=('node', '-e', "const{Pool}=require('pg');const p=new Pool();require('./test/helpers/migrations.cjs').migrate(p).then(()=>p.end(),async e=>{console.error(e.code||'schema-failed');await p.end();process.exit(1)})"))
            else:
                create(name, images['liquibase'], '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{side}-db:5432/dva_webhook_test',
                       '-e', 'LIQUIBASE_COMMAND_USERNAME='+side+'_app', '-e', 'LIQUIBASE_COMMAND_PASSWORD='+password,
                       command=('--changelog-file='+side+'/db.changelog.xml', 'update'))
            complete(name)
        # The original fixture and ORD-02/03 assertions run without modifying backend files.
        reference = LOGS/'order-reads-reference.cjs'
        reference.write_text("const suite=require('./helpers/orders.cjs')();require('./orders-reads.cjs')(suite);\n", encoding='utf-8')
        name = RUN+'-reference-suite'
        create(name, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_HOST=127.0.0.1', '-e', 'DB_PORT=5432',
               '-e', 'DB_USER=monolith_app', '-e', 'DB_PASSWORD='+password, '-e', 'DB_NAME=dva_webhook_test',
               '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_AGENT_URL=http://ai.invalid:8000', network='container:'+RUN+'-monolith-db',
               command=('node', '--test', 'test/order-reads-reference.cjs'))
        run('docker', 'cp', str(reference), name+':/app/test/order-reads-reference.cjs', label='reference-copy')
        complete(name)
        name = RUN+'-reference-deletion-suite'
        create(name, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_HOST=127.0.0.1', '-e', 'DB_PORT=5432',
               '-e', 'DB_USER=monolith_app', '-e', 'DB_PASSWORD='+password, '-e', 'DB_NAME=dva_webhook_test',
               '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_AGENT_URL=http://ai.invalid:8000', network='container:'+RUN+'-monolith-db',
               command=('node', '--test', '--test-name-pattern=new DELETE routes|order soft deletion|live calls|order/call deletion', 'test/soft-deletion.integration.test.cjs'))
        complete(name)
        for side, port in (('monolith', 3000), ('operations', 3005), ('customer', 3001), ('consultation', 3004), ('order', 3002)):
            name = RUN+'-'+side+'-app'
            create(name, images[side], '--network-alias', side+'-app', '-e', 'NODE_ENV=production', '-e', 'PORT='+str(port),
                   '-e', 'DB_HOST='+side+'-db', '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password,
                   '-e', 'DB_NAME=dva_webhook_test', '-e', 'SECURITY_LOG_HMAC_KEY='+uuid.uuid4().hex+uuid.uuid4().hex,
                   '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true', '-e', 'AI_BUSINESS_TOKEN='+password,
                   '-e', 'AI_AGENT_URL=http://ai.invalid:8000', '-e', 'OPERATIONS_URL=http://operations-app:3005',
                   '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'CONSULTATION_URL=http://consultation-app:3004',
                   '-e', 'ORDER_URL=http://order-app:3002', '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token)
            run('docker', 'start', name, label=side+'-app-start')
        name = RUN+'-differential'
        create(name, images['order-checks'], '-e', 'NODE_ENV=test', '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token,
               command=('node', '--test', 'test/order-reads-parity.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/order-reads-parity.test.cjs'), name+':/app/service/test/order-reads-parity.test.cjs', label='differential-copy')
        complete(name)
        for suite in ['order-deletion-parity', 'order-deletion-recovery']:
            name = RUN+'-'+suite
            create(name, images['order-checks'], '-e', 'NODE_ENV=test', '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
                   '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token,
                   command=('node', '--test', 'test/'+suite+'.test.cjs'))
            for file in [suite+'.test.cjs'] + (['order-deletion-claimant.cjs'] if suite.endswith('recovery') else []):
                run('docker', 'cp', str(ROOT/'msa/parity'/file), name+':/app/service/test/'+file, label=suite+'-copy-'+file)
            complete(name)
        run('docker', 'stop', '--time=5', RUN+'-consultation-app', label='consultation-outage')
        name = RUN+'-outage'
        create(name, images['order-checks'], '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               command=('node', '--test', 'test/order-read-outage.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/order-read-outage.test.cjs'), name+':/app/service/test/order-read-outage.test.cjs', label='outage-copy')
        complete(name)
        report['passed'] = True
    finally:
        for kind, name in reversed(resources):
            result = subprocess.run(['docker', kind, 'inspect', name], capture_output=True)
            if result.returncode:
                continue
            item = json.loads(result.stdout)[0]
            labels = item.get('Labels') if kind == 'network' else item.get('Config', {}).get('Labels')
            if not labels or labels.get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of unowned Docker resource: '+name)
            if kind == 'container' and name.endswith('-app'):
                result = subprocess.run(['docker', 'logs', name], capture_output=True)
                (LOGS/(name+'.log')).write_text((result.stdout+result.stderr).decode('utf-8', 'replace'), encoding='utf-8')
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name, label=name+'-cleanup')
        (LOGS/'verification.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
