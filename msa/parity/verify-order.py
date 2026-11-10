"""Compare order APIs and billing-month initialization on six isolated PostgreSQL DBs."""
import json
from pathlib import Path
import subprocess
import time
import uuid
from ci_images import prepared_image
from verify_parcel_draft_upgrade import verify_parcel_draft_upgrade

ROOT = Path(__file__).resolve().parents[2]
RUN = 'dva-order-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN
LOGS = ROOT / 'msa/liquibase/verification-logs/order'


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    resources = []
    report = {'passed': False, 'checks': [], 'environment': 'production',
              'billingPhases': {'deterministic': {'nodeEnv': 'test', 'automaticBusinessWorkers': False},
                                'scheduler': {'nodeEnv': 'production', 'automaticBusinessWorkers': True}},
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
        if '--test' in command:
            run('docker', 'cp', str(ROOT/'msa/parity/fixture-reset.cjs'), name+':/app/service/test/fixture-reset.cjs',
                label=name+'-copy-fixture-reset')

    def complete(name):
        run('docker', 'start', '--attach', name, label=name+'-run')
        code = run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name+'-exit')
        if code != '0':
            raise RuntimeError(name+' exited with '+code)

    password, token = uuid.uuid4().hex, uuid.uuid4().hex
    try:
        images = {}
        for side, path, target in (
            ('delivery', 'msa/services/delivery', None),
            ('order-checks', 'msa/services/order', 'checks'), ('order', 'msa/services/order', None),
            ('customer', 'msa/services/customer', None), ('consultation', 'msa/services/consultation', None),
            ('operations', 'msa/services/operations', None),
            ('monolith', 'backend', None), ('liquibase', 'msa/liquibase', None),
        ):
            image = prepared_image(side)
            if image:
                images[side] = image
                report.setdefault('images', {})[side] = image
                print(side + '-reuse', flush=True)
                continue
            image = RUN+'-'+side
            resources.append(('image', image))
            context = ['-f', str(ROOT/path/'Dockerfile'), str(ROOT/'msa')] if path.startswith('msa/services/') else [str(ROOT/path)]
            run('docker', 'build', '--label', LABEL, '-t', image, *(['--target', target] if target else []), *context, label=side+'-build')
            images[side] = image
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        for side in ('monolith', 'operations', 'customer', 'consultation', 'delivery', 'order'):
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
                create(name, images['monolith'], '-e', 'NODE_ENV=test', '-e', 'DB_NAME=dva_webhook_test',
                       '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PGHOST=monolith-db', '-e', 'PGUSER=monolith_app',
                       '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
                       command=('node', '/app/migrate-reference.cjs'))
                run('docker', 'cp', str(ROOT/'msa/parity/migrate-reference.cjs'), name+':/app/migrate-reference.cjs', label='reference-schema-copy')
            else:
                create(name, images['liquibase'], '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{side}-db:5432/dva_webhook_test',
                       '-e', 'LIQUIBASE_COMMAND_USERNAME='+side+'_app', '-e', 'LIQUIBASE_COMMAND_PASSWORD='+password,
                       command=('--changelog-file='+side+'/db.changelog.xml', 'update'))
            complete(name)
        verify_parcel_draft_upgrade(ROOT, RUN, images, password, token, run, create, complete)
        for side in ('order', 'consultation'):
            run('docker', 'stop', '--time=5', RUN+'-'+side+'-draft-app', label='draft-'+side+'-stop')
        for side, port in (('monolith', 3000), ('operations', 3005), ('customer', 3001), ('consultation', 3004), ('delivery', 3003), ('order', 3002)):
            name = RUN+'-'+side+'-app'
            create(name, images[side], '--network-alias', side+'-app', '-e', 'NODE_ENV=production', '-e', 'PORT='+str(port),
                   '-e', 'DB_HOST='+side+'-db', '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password,
                   '-e', 'DB_NAME=dva_webhook_test', '-e', 'SECURITY_LOG_HMAC_KEY='+uuid.uuid4().hex+uuid.uuid4().hex,
                   '-e', 'CORS_ORIGINS=http://localhost:5173,https://payments.example.test', '-e', 'SWAGGER_ENABLED=true', '-e', 'AI_BUSINESS_TOKEN='+password,
                   *(['-e', 'ORDER_PAYMENTS_ENABLED=true', '-e', 'PAYMENT_PUBLIC_URL=https://payments.example.test/api/payments',
                      '-e', 'TOSS_TEST_CLIENT_KEY=test_gck_parity', '-e', 'TOSS_TEST_SECRET_KEY=test_gsk_parity',
                      '-e', 'PAYMENT_MATTERMOST_WEBHOOK_URL=https://mattermost.example.test/hooks/parity'] if side in ('monolith', 'order') else []),
                   '-e', 'AI_AGENT_URL=http://ai.invalid:8000', '-e', 'OPERATIONS_URL=http://operations-app:3005',
                   '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'CONSULTATION_URL=http://consultation-app:3004',
                   '-e', 'DELIVERY_URL=http://delivery-app:3003', '-e', 'ORDER_URL=http://order-app:3002', '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token)
            run('docker', 'start', name, label=side+'-app-start')
            if side == 'consultation':
                # Order restores legacy call bindings through consultation during bootstrap.
                run('docker', 'exec', name, 'node', '-e', "(async()=>{for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3004/consultation/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('consultation startup unavailable')})().catch(()=>process.exit(1))", label='consultation-app-ready')
        name = RUN+'-differential'
        create(name, images['order-checks'], '-e', 'NODE_ENV=test', '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token,
               command=('node', '--test', 'test/order-reads-parity.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/order-reads-parity.test.cjs'), name+':/app/service/test/order-reads-parity.test.cjs', label='differential-copy')
        complete(name)
        for suite in ['order-deletion-parity', 'order-deletion-recovery', 'order-cancellation-parity', 'order-cancellation-recovery', 'parcel-draft-compatibility']:
            name = RUN+'-'+suite
            create(name, images['order-checks'], '-e', 'NODE_ENV=test', '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
                   '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token,
                   command=('node', '--test', 'test/'+suite+'.test.cjs'))
            for file in [suite+'.test.cjs'] + ([suite.replace('-recovery', '-claimant')+'.cjs'] if suite.endswith('recovery') else []):
                run('docker', 'cp', str(ROOT/'msa/parity'/file), name+':/app/service/test/'+file, label=suite+'-copy-'+file)
            complete(name)
        run('docker', 'stop', '--time=5', RUN+'-delivery-app', label='delivery-outage')
        name = RUN+'-delivery-outage'
        create(name, images['order-checks'], '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               command=('node', '--test', 'test/order-cancellation-outage.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/order-cancellation-outage.test.cjs'), name+':/app/service/test/order-cancellation-outage.test.cjs', label='delivery-outage-copy')
        complete(name)
        run('docker', 'stop', '--time=5', RUN+'-consultation-app', label='consultation-outage')
        name = RUN+'-outage'
        create(name, images['order-checks'], '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               command=('node', '--test', 'test/order-read-outage.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/order-read-outage.test.cjs'), name+':/app/service/test/order-read-outage.test.cjs', label='outage-copy')
        complete(name)
        # Isolate deterministic rollover instants from the real 10-second production timers.
        for side in ('monolith', 'order'):
            run('docker', 'stop', '--time=5', RUN+'-'+side+'-app', label=side+'-billing-controlled-stop')
            name = RUN+'-'+side+'-billing-app'
            create(name, images[side], '--network-alias', side+'-app', '-e', 'NODE_ENV=test', '-e', 'PORT='+('3000' if side=='monolith' else '3002'),
                   '-e', 'DB_HOST='+side+'-db', '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password, '-e', 'DB_NAME=dva_webhook_test',
                   '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true', '-e', 'AI_BUSINESS_TOKEN='+password,
                   '-e', 'AI_AGENT_URL=http://ai.invalid:8000', '-e', 'OPERATIONS_URL=http://operations-app:3005',
                   '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'CONSULTATION_URL=http://consultation-app:3004',
                   '-e', 'DELIVERY_URL=http://delivery-app:3003', '-e', 'CUSTOMER_AUTH_TOKEN='+password)
            run('docker', 'start', name, label=side+'-billing-controlled-start')
        runtime = LOGS/'billing-monolith-runtime'
        runtime.mkdir(exist_ok=True)
        run('docker', 'cp', RUN+'-monolith-app:/app/dist/.', str(runtime), label='billing-source-runtime')
        for suite in ('billing-months-parity', 'billing-months-recovery'):
            name = RUN+'-'+suite
            create(name, images['order-checks'], '-e', 'NODE_ENV=test', '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
                   '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token,
                   command=('node', '--test', 'test/'+suite+'.test.cjs'))
            run('docker', 'cp', str(runtime), name+':/app/service/test/monolith-runtime', label=suite+'-source-copy')
            for file in [suite+'.test.cjs'] + (['billing-months-claimant.cjs'] if suite.endswith('recovery') else []):
                run('docker', 'cp', str(ROOT/'msa/parity'/file), name+':/app/service/test/'+file, label=suite+'-copy-'+file)
            complete(name)
        for side in ('monolith', 'order'):
            run('docker', 'stop', '--time=5', RUN+'-'+side+'-billing-app', label=side+'-billing-controlled-finish')
            run('docker', 'start', RUN+'-'+side+'-app', label=side+'-billing-production-restart')
        name = RUN+'-billing-scheduler'
        create(name, images['order-checks'], '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               command=('node', '--test', 'test/billing-months-scheduler.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/billing-months-scheduler.test.cjs'), name+':/app/service/test/billing-months-scheduler.test.cjs', label='billing-scheduler-copy')
        complete(name)
        run('docker', 'stop', '--time=5', RUN+'-order-app', label='billing-order-outage')
        name = RUN+'-billing-outage'
        create(name, images['order-checks'], '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               command=('node', '--test', 'test/billing-months-outage.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/billing-months-outage.test.cjs'), name+':/app/service/test/billing-months-outage.test.cjs', label='billing-outage-copy')
        complete(name)
        run('docker', 'start', RUN+'-consultation-app', label='draft-deletion-consultation-restart')
        run('docker', 'exec', RUN+'-consultation-app', 'node', '-e', "(async()=>{for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3004/consultation/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('consultation startup unavailable')})().catch(()=>process.exit(1))", label='draft-deletion-consultation-ready')
        name = RUN+'-draft-deletion-outage'
        create(name, images['order-checks'], '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               command=('node', '--test', 'test/parcel-draft-deletion-outage.test.cjs'))
        run('docker', 'cp', str(ROOT/'msa/parity/parcel-draft-deletion-outage.test.cjs'), name+':/app/service/test/parcel-draft-deletion-outage.test.cjs', label='draft-deletion-outage-copy')
        complete(name)
        report['passed'] = True
    finally:
        if not report['passed']:
            names = [name for kind, name in resources if kind == 'container']
            if names:
                try:
                    result = subprocess.run(['docker', 'stats', '--no-stream', *names], capture_output=True, timeout=20)
                    (LOGS / 'failure-resources.log').write_text((result.stdout + result.stderr).decode('utf-8', 'replace'), encoding='utf-8')
                except subprocess.TimeoutExpired:
                    (LOGS / 'failure-resources.log').write_text('Resource snapshot timed out; preserve the original verification failure.\n')
        for kind, name in reversed(resources):
            result = subprocess.run(['docker', kind, 'inspect', name], capture_output=True)
            if result.returncode:
                continue
            item = json.loads(result.stdout)[0]
            labels = item.get('Labels') if kind == 'network' else item.get('Config', {}).get('Labels')
            if not labels or labels.get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of unowned Docker resource: '+name)
            if kind == 'container' and name.endswith(('-app', '-db')):
                result = subprocess.run(['docker', 'logs', name], capture_output=True)
                (LOGS/(name+'.log')).write_text((result.stdout+result.stderr).decode('utf-8', 'replace'), encoding='utf-8')
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name, label=name+'-cleanup')
        (LOGS/'verification.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
