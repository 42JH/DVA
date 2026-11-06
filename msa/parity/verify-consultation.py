"""Compare unchanged PBX/worker tests and production PBX/SSE on isolated Docker DBs."""
import json
from pathlib import Path
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
RUN = 'dva-consultation-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN
LOGS = ROOT / 'msa/liquibase/verification-logs/consultation'


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    resources = []
    report = {'passed': False, 'checks': [], 'reference': subprocess.check_output(
        ['git', 'rev-parse', 'HEAD:backend'], cwd=ROOT, text=True).strip()}

    def run(*args, label):
        result = subprocess.run(args, text=True, encoding='utf-8', errors='replace',
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=900)
        (LOGS / (label + '.log')).write_text(result.stdout, encoding='utf-8')
        if result.returncode:
            raise RuntimeError(label + ': ' + result.stdout[-5000:])
        report['checks'].append(label)
        print(label, flush=True)
        return result.stdout.strip()

    def create(name, image, *args, command=(), network=RUN):
        run('docker', 'create', '--name', name, '--label', LABEL, '--network', network,
            *args, image, *command, label=name+'-create')
        resources.append(('container', name))

    def complete(name):
        run('docker', 'start', '--attach', name, label=name+'-run')
        assert run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name+'-exit') == '0'

    password, token, pbx = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
    try:
        images = {}
        for side, path, target in (
            ('consultation-checks', 'msa/services/consultation', 'checks'),
            ('consultation', 'msa/services/consultation', None),
            ('operations', 'msa/services/operations', None), ('customer', 'msa/services/customer', None),
            ('monolith-checks', 'backend', 'checks'), ('monolith', 'backend', None),
            ('liquibase', 'msa/liquibase', None),
        ):
            image = RUN+'-'+side
            resources.append(('image', image))
            context = ['-f', str(ROOT/path/'Dockerfile'), str(ROOT/'msa')] if side in ('operations', 'customer', 'consultation', 'consultation-checks') else [str(ROOT/path)]
            run('docker', 'build', '--label', LABEL, '-t', image,
                *(['--target', target] if target else []), *context, label=side+'-build')
            images[side] = image
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        for side in ('monolith', 'operations', 'customer', 'consultation'):
            name = RUN+'-'+side+'-db'
            create(name, 'postgres:17.11-bookworm', '--network-alias', side+'-db',
                   '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER='+side+'_app',
                   '-e', 'POSTGRES_PASSWORD='+password, '-e', 'POSTGRES_DB=dva_webhook_test')
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
                       '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PGHOST=monolith-db',
                       '-e', 'PGUSER=monolith_app', '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
                       command=('node', '-e', "const{Pool}=require('pg');const p=new Pool();require('./test/helpers/migrations.cjs').migrate(p).then(()=>p.end(),async e=>{console.error(e.code||'schema-failed');await p.end();process.exit(1)})"))
            else:
                create(name, images['liquibase'], '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{side}-db:5432/dva_webhook_test',
                       '-e', 'LIQUIBASE_COMMAND_USERNAME='+side+'_app', '-e', 'LIQUIBASE_COMMAND_PASSWORD='+password,
                       command=('--changelog-file='+side+'/db.changelog.xml', 'update'))
            complete(name)
        for side in ('monolith', 'consultation'):
            name = RUN+'-'+side+'-suite'
            create(name, images[side+'-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_HOST=127.0.0.1',
                   '-e', 'DB_PORT=5432', '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password,
                   '-e', 'DB_NAME=dva_webhook_test', '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_AGENT_URL=http://ai.invalid:8000',
                   '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'OPERATIONS_URL=http://operations-app:3005',
                   '-e', 'CONSULTATION_AUTH_TOKEN='+token, '-e', 'CUSTOMER_AUTH_TOKEN='+password, network='container:'+RUN+'-'+side+'-db',
                   command=('node', *(['--require', './test/analysis-environment-fixture.cjs'] if side == 'consultation' else []),
                            '--test', '--test-concurrency=1', 'test/webhook.integration.test.cjs', 'test/consultation-worker.test.cjs',
                            'test/call-analysis.test.cjs', 'test/call-dashboard-metrics.test.cjs',
                            *(['test/caller-context.integration.test.cjs', 'test/customers.integration.test.cjs', 'test/pins.integration.test.cjs',
                               'test/call-analysis.integration.test.cjs', 'test/call-dashboard-metrics.integration.test.cjs'] if side == 'monolith' else [])))
            for source in (ROOT/'backend/test/webhook.integration.test.cjs', ROOT/'msa/parity/consultation-worker.test.cjs',
                           ROOT/'backend/test/call-analysis.test.cjs', ROOT/'backend/test/call-dashboard-metrics.test.cjs',
                           *([ROOT/'backend/test/caller-context.integration.test.cjs', ROOT/'backend/test/customers.integration.test.cjs', ROOT/'backend/test/pins.integration.test.cjs',
                              ROOT/'backend/test/call-analysis.integration.test.cjs', ROOT/'backend/test/call-dashboard-metrics.integration.test.cjs'] if side == 'monolith' else [ROOT/'msa/parity/analysis-environment-fixture.cjs'])):
                target = '/app/test/' if side == 'monolith' else '/app/service/test/'
                run('docker', 'cp', str(source), name+':'+target+source.name, label=side+'-copy-'+source.name)
            complete(name)
        def start_apps(environment):
            for side, port in (('monolith', '3000'), ('operations', '3005'), ('customer', '3001'), ('consultation', '3004')):
                name = RUN+'-'+side+'-app'
                create(name, images[side], '--network-alias', side+'-app',
                       '-e', 'NODE_ENV='+environment, '-e', 'PORT='+port, '-e', 'DB_HOST='+side+'-db',
                       '-e', 'SECURITY_LOG_HMAC_KEY='+uuid.uuid4().hex+uuid.uuid4().hex,
                       '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password, '-e', 'DB_NAME=dva_webhook_test',
                       '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true',
                       '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_INSIGHTS_TOKEN='+pbx, '-e', 'AI_AGENT_URL=http://ai.invalid:8000', '-e', 'S3_RECORDINGS_BUCKET=',
                       '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'OPERATIONS_URL=http://operations-app:3005', '-e', 'CONSULTATION_AUTH_TOKEN='+token,
                       '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_URL=http://consultation-app:3004',
                       '-e', 'PBX_WEBHOOK_TOKEN='+pbx)
                run('docker', 'start', name, label=side+'-app-start')
        start_apps('production')
        run('docker', 'cp', RUN+'-operations-app:/app/service/dist/auth/password.js',
            str(LOGS/'seed-password.cjs'), label='password-fixture-copy')
        name = RUN+'-differential'
        create(name, images['consultation-checks'], '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PBX_WEBHOOK_TOKEN='+pbx,
               command=('node', '--test', 'test/consultation-pbx.test.cjs'))
        for source in (ROOT/'msa/parity/consultation-pbx.test.cjs', LOGS/'seed-password.cjs'):
            run('docker', 'cp', str(source), name+':/app/service/test/'+source.name, label='copy-'+source.name)
        complete(name)
        name = RUN+'-call-analysis'
        create(name, images['consultation-checks'], '-e', 'AI_INSIGHTS_TOKEN='+pbx, '-e', 'PGPASSWORD='+password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'CONSULTATION_AUTH_TOKEN='+token,
               '-e', 'CUSTOMER_AUTH_TOKEN='+password,
               command=('node', '--test', 'test/call-analysis-parity.test.cjs'))
        for source in (ROOT/'msa/parity/call-analysis-parity.test.cjs', ROOT/'msa/parity/analysis-claimant.cjs'):
            run('docker', 'cp', str(source), name+':/app/service/test/'+source.name, label='analysis-copy-'+source.name)
        complete(name)
        # Keep production PBX/SSE distinct from foreground context checks without the
        # monolith's still-unported monthly order/billing maintenance worker.
        for side in ('monolith', 'operations', 'customer', 'consultation'):
            name = RUN+'-'+side+'-app'
            run('docker', 'stop', '--time=5', name, label=side+'-production-stop')
            run('docker', 'rm', name, label=side+'-production-remove')
        start_apps('test')
        name = RUN+'-caller-context'
        runtime = LOGS/'customer-runtime'
        runtime.mkdir(exist_ok=True)
        run('docker', 'cp', RUN+'-customer-app:/app/service/dist/.', str(runtime), label='context-consumer-runtime')
        create(name, images['consultation-checks'], '-e', 'NODE_ENV=test', '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PBX_WEBHOOK_TOKEN='+pbx,
               '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_AUTH_TOKEN='+token,
               command=('node', '--test', 'test/caller-context.test.cjs'))
        run('docker', 'cp', str(runtime), name+':/app/service/test/customer-runtime', label='context-consumer-copy')
        for source in (ROOT/'msa/parity/caller-context.test.cjs', ROOT/'msa/parity/context-claimant.cjs', LOGS/'seed-password.cjs'):
            run('docker', 'cp', str(source), name+':/app/service/test/'+source.name, label='context-copy-'+source.name)
        complete(name)
        name = RUN+'-customer-pins'
        create(name, images['consultation-checks'], '-e', 'NODE_ENV=test', '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'CUSTOMER_AUTH_TOKEN='+password,
               '-e', 'CONSULTATION_AUTH_TOKEN='+token,
               command=('node', '--test', 'test/customer-pins.test.cjs'))
        run('docker', 'cp', str(runtime), name+':/app/service/test/customer-runtime', label='pins-consumer-copy')
        for source in (ROOT/'msa/parity/customer-pins.test.cjs', ROOT/'msa/parity/pin-scope-claimant.cjs', LOGS/'seed-password.cjs'):
            run('docker', 'cp', str(source), name+':/app/service/test/'+source.name, label='pins-copy-'+source.name)
        complete(name)
        report['passed'] = True
    finally:
        for kind, name in reversed(resources):
            result = subprocess.run(['docker', kind, 'inspect', name], capture_output=True, text=True)
            if result.returncode:
                continue
            item = json.loads(result.stdout)[0]
            labels = item.get('Labels') if kind == 'network' else item.get('Config', {}).get('Labels')
            if not labels or labels.get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of unowned Docker resource: '+name)
            if kind == 'container' and name.endswith('-app'):
                result = subprocess.run(['docker', 'logs', name], capture_output=True, text=True,
                                        encoding='utf-8', errors='replace')
                (LOGS/(name+'.log')).write_text(result.stdout+result.stderr, encoding='utf-8')
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name, label=name+'-cleanup')
        (LOGS/'verification.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
