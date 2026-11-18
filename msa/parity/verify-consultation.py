"""Compare unchanged PBX/worker tests and production PBX/SSE on isolated Docker DBs."""
import json
import re
from pathlib import Path
import subprocess
import time
import uuid
from ci_images import prepared_image

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
        if '--test' in command and image!=images['monolith']:
            run('docker', 'cp', str(ROOT/'msa/parity/fixture-reset.cjs'), name+':/app/service/test/fixture-reset.cjs',
                label=name+'-copy-fixture-reset')

    def complete(name):
        run('docker', 'start', '--attach', name, label=name+'-run')
        assert run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name+'-exit') == '0'

    password, token, pbx = uuid.uuid4().hex, uuid.uuid4().hex, uuid.uuid4().hex
    try:
        images = {}
        for side, path, target in (
            ('consultation-checks', 'msa/services/consultation', 'checks'),
            ('consultation', 'msa/services/consultation', None),
            ('order', 'msa/services/order', None), ('operations', 'msa/services/operations', None), ('customer', 'msa/services/customer', None),
            ('monolith', 'backend', None),
            ('liquibase', 'msa/liquibase', None),
        ):
            image = prepared_image(side)
            if image:
                images[side] = image
                report.setdefault('images', {})[side] = image
                print(side + '-reuse', flush=True)
                continue
            image = RUN+'-'+side
            resources.append(('image', image))
            context = ['-f', str(ROOT/path/'Dockerfile'), str(ROOT/'msa')] if side in ('order', 'operations', 'customer', 'consultation', 'consultation-checks') else [str(ROOT/path)]
            run('docker', 'build', '--label', LABEL, '-t', image,
                *(['--target', target] if target else []), *context, label=side+'-build')
            images[side] = image
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        for side in ('monolith', 'operations', 'customer', 'consultation', 'order'):
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
                create(name, images['monolith'], '-e', 'NODE_ENV=test', '-e', 'DB_NAME=dva_webhook_test',
                       '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PGHOST=monolith-db',
                       '-e', 'PGUSER=monolith_app', '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
                       command=('node', '/app/migrate-reference.cjs'))
                run('docker', 'cp', str(ROOT/'msa/parity/migrate-reference.cjs'), name+':/app/migrate-reference.cjs', label='reference-schema-copy')
            else:
                create(name, images['liquibase'], '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{side}-db:5432/dva_webhook_test',
                       '-e', 'LIQUIBASE_COMMAND_USERNAME='+side+'_app', '-e', 'LIQUIBASE_COMMAND_PASSWORD='+password,
                       command=('--changelog-file='+side+'/db.changelog.xml', 'update'))
            complete(name)
        side = 'consultation'
        name = RUN+'-'+side+'-suite'
        create(name, images[side+'-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_HOST=127.0.0.1',
               '-e', 'DB_PORT=5432', '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password,
               '-e', 'DB_NAME=dva_webhook_test', '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_AGENT_URL=http://ai.invalid:8000',
               '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'OPERATIONS_URL=http://operations-app:3005',
               '-e', 'CONSULTATION_AUTH_TOKEN='+token, '-e', 'CUSTOMER_AUTH_TOKEN='+password, network='container:'+RUN+'-'+side+'-db',
               command=('node', '--require', './test/analysis-environment-fixture.cjs',
                        '--test', '--test-concurrency=1',
                        # The backend-only prepared-query optimization is outside this migration.
                        '--test-skip-pattern=^prepared statement identity depends on SQL, while request values remain bound$',
                        'test/webhook.integration.test.cjs', 'test/consultation-worker.test.cjs',
                        'test/call-analysis.test.cjs', 'test/call-dashboard-metrics.test.cjs', 'test/unanswered-questions.test.cjs', 'test/call-events.test.cjs', 'test/complaint-judge.test.cjs'))
        for source in (ROOT/'backend/test/webhook.integration.test.cjs', ROOT/'msa/parity/consultation-worker.test.cjs',
                       ROOT/'backend/test/call-analysis.test.cjs', ROOT/'backend/test/call-dashboard-metrics.test.cjs', ROOT/'backend/test/unanswered-questions.test.cjs', ROOT/'backend/test/call-events.test.cjs',
                       ROOT/'backend/test/complaint-judge.test.cjs', ROOT/'msa/parity/analysis-environment-fixture.cjs'):
            target = '/app/service/test/'
            run('docker', 'cp', str(source), name+':'+target+source.name, label=side+'-copy-'+source.name)
        run('docker', 'cp', str(ROOT/'backend/test/fixtures'), name+':/app/service/test/fixtures', label='complaint-cases-copy')
        complete(name)
        side = 'consultation'
        name=RUN+'-'+side+'-recording-policy-suite'
        create(name,images[side+'-checks'],'-e','NODE_ENV=test','-e','DB_HOST=127.0.0.1',
               '-e','DB_PORT=5432','-e','DB_USER='+side+'_app','-e','DB_PASSWORD='+password,
               '-e','DB_NAME=dva_webhook_test','-e','AI_BUSINESS_TOKEN='+password,'-e','AI_AGENT_URL=http://ai.invalid:8000',
               '-e','CUSTOMER_URL=http://customer-app:3001','-e','OPERATIONS_URL=http://operations-app:3005',
               '-e','CONSULTATION_AUTH_TOKEN='+token,'-e','CUSTOMER_AUTH_TOKEN='+password,
               network='container:'+RUN+'-'+side+'-db',command=('node','--test',
               '--test-name-pattern=transient recording errors|policy errors stop|attempts survive worker crashes|legacy review holds',
               'test/recordings.integration.test.cjs'))
        target='/app/service/test/'
        run('docker','cp',str(ROOT/'backend/test/recordings.integration.test.cjs'),name+':'+target+'recordings.integration.test.cjs',label=side+'-recording-policy-copy')
        complete(name)
        def start_apps(environment):
            for side, port in (('monolith', '3000'), ('operations', '3005'), ('customer', '3001'), ('consultation', '3004'), ('order', '3002')):
                name = RUN+'-'+side+'-app'
                create(name, images[side], '--network-alias', side+'-app',
                       '-e', 'NODE_ENV='+environment, '-e', 'PORT='+port, '-e', 'DB_HOST='+side+'-db',
                       '-e', 'SECURITY_LOG_HMAC_KEY='+uuid.uuid4().hex+uuid.uuid4().hex,
                       '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password, '-e', 'DB_NAME=dva_webhook_test',
                       '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true',
                       '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_INSIGHTS_TOKEN='+pbx, '-e', 'AI_AGENT_URL=http://ai.invalid:8000', '-e', 'S3_RECORDINGS_BUCKET=',
                       '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'OPERATIONS_URL=http://operations-app:3005', '-e', 'CONSULTATION_AUTH_TOKEN='+token,
                       '-e', 'CUSTOMER_AUTH_TOKEN='+password, '-e', 'CONSULTATION_URL=http://consultation-app:3004',
                       '-e', 'ORDER_URL=http://order-app:3002', '-e', 'DELIVERY_URL=http://delivery-app:3003', '-e', 'PBX_WEBHOOK_TOKEN='+pbx,
                       *(['-e','TOSS_BILLING_SECRET_KEY=test_sk_card_parity','-e','PAYMENT_CARD_ENCRYPTION_KEY='+'01'*32,
                          '-e','PAYMENT_TOSS_BASE_URL=http://127.0.0.1:8000'] if environment=='test' and side in ('monolith','customer') else []))
                run('docker', 'start', name, label=side+'-app-start')
                if environment=='test' and side in ('monolith','customer'):
                    peer=RUN+'-'+side+'-card-peer'
                    create(peer,images[side],'-e','NODE_ENV=test','-e','FINAL_SERVICE_TOKEN='+password,
                           '-e','FINAL_TOSS_BILLING_SECRET_KEY=test_sk_card_parity',
                           command=('node','/tmp/final-peer.cjs'),network='container:'+name)
                    run('docker','cp',str(ROOT/'msa/parity/final-peer.cjs'),peer+':/tmp/final-peer.cjs',label=side+'-card-peer-copy')
                    run('docker','start',peer,label=side+'-card-peer-start')
                    run('docker','exec',peer,'node','-e',"(async()=>{for(let n=0;n<100;n++){try{if((await fetch('http://127.0.0.1:8000/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('card fixture unavailable')})().catch(()=>process.exit(1))",label=side+'-card-peer-ready')
                if side == 'consultation':
                    run('docker', 'exec', name, 'node', '-e', "(async()=>{for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3004/consultation/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('consultation startup unavailable')})().catch(()=>process.exit(1))", label='consultation-startup-'+environment)
        start_apps('production')
        run('docker', 'cp', RUN+'-operations-app:/app/service/dist/auth/password.js',
            str(LOGS/'seed-password.cjs'), label='password-fixture-copy')
        name = RUN+'-complaint-integration'
        create(name, images['consultation-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_HOST=127.0.0.1',
               '-e', 'DB_PORT=5432', '-e', 'DB_USER=consultation_app', '-e', 'DB_PASSWORD='+password,
               '-e', 'DB_NAME=dva_webhook_test', '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_AGENT_URL=http://ai.invalid:8000',
               '-e', 'CUSTOMER_URL=http://customer-app:3001', '-e', 'OPERATIONS_URL=http://operations-app:3005',
               '-e', 'ORDER_URL=http://order-app:3002', '-e', 'CONSULTATION_AUTH_TOKEN='+token, '-e', 'CUSTOMER_AUTH_TOKEN='+password,
               network='container:'+RUN+'-consultation-db',
               command=('node', '--require', './test/analysis-environment-fixture.cjs', '--test', 'test/complaint-judge.integration.test.cjs'))
        source = (ROOT/'backend/test/complaint-judge.integration.test.cjs').read_text(encoding='utf-8')
        source, count = re.subn(r'await f\.pool\.query\((\s*"SELECT [^"\n]*FROM audit_logs[^"\n]*")',
                                r'await f.audit.query(\1', source)
        assert count == 4, 'Source complaint audit ownership queries changed'
        fixture = LOGS/'complaint-judge.integration.test.cjs'
        fixture.write_text(source, encoding='utf-8')
        run('docker', 'cp', str(fixture),
            name+':/app/service/test/complaint-judge.integration.test.cjs', label='complaint-integration-copy')
        run('docker', 'cp', str(ROOT/'msa/services/consultation/test/helpers/application.cjs'),
            name+':/app/service/test/helpers/application.cjs', label='complaint-fixture-copy')
        run('docker', 'cp', str(ROOT/'msa/parity/analysis-environment-fixture.cjs'),
            name+':/app/service/test/analysis-environment-fixture.cjs', label='complaint-rule-fixture-copy')
        complete(name)
        name = RUN+'-differential'
        create(name, images['consultation-checks'], '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PBX_WEBHOOK_TOKEN='+pbx,
               command=('node', '--test', '--test-skip-pattern=^consultation retention', 'test/consultation-pbx.test.cjs'))
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
        name = RUN+'-call-content'
        create(name, images['consultation-checks'], '-e', 'AI_INSIGHTS_TOKEN='+pbx, '-e', 'PGPASSWORD='+password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'CONSULTATION_AUTH_TOKEN='+token,
               '-e', 'CUSTOMER_AUTH_TOKEN='+password,
               command=('node', '--test', 'test/call-content-parity.test.cjs'))
        for source in (ROOT/'msa/parity/call-content-parity.test.cjs', ROOT/'msa/parity/call-content-claimant.cjs'):
            run('docker', 'cp', str(source), name+':/app/service/test/'+source.name, label='content-copy-'+source.name)
        complete(name)
        # Keep production PBX/SSE distinct from foreground context checks without the
        # monolith's still-unported monthly order/billing maintenance worker.
        for side in ('monolith', 'operations', 'customer', 'consultation', 'order'):
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
        for side in ('monolith','operations','customer','consultation','order'):
            run('docker','stop','--time=5',RUN+'-'+side+'-app',label=side+'-stop-before-retention-claims')
        claims={}
        probe=LOGS/'retention-claims-probe';probe.mkdir(exist_ok=True)
        for source in (ROOT/'msa/parity/consultation-pbx.test.cjs',ROOT/'msa/parity/fixture-reset.cjs',LOGS/'seed-password.cjs'):
            (probe/source.name).write_bytes(source.read_bytes())
        for side in ('monolith','consultation'):
            name=RUN+'-'+side+'-retention-claims'
            create(name,images['monolith'] if side=='monolith' else images['consultation-checks'],
                   '-e','NODE_ENV=test','-e','PGDATABASE=dva_webhook_test','-e','PGPASSWORD='+password,
                   '-e','PGHOST='+side+'-db','-e','PGUSER='+side+'_app',
                   command=('node','--test','--test-name-pattern=^consultation retention','test/consultation-pbx.test.cjs'))
            run('docker','cp',str(probe)+'/.',name+':/app/'+('' if side=='monolith' else 'service/')+'test',label=side+'-claims-copy')
            complete(name)
            claims[side]={}
            for line in run('docker','logs',name,label=side+'-claims-results').splitlines():
                try:value=json.loads(line.removeprefix('# '))
                except ValueError:continue
                if 'retentionClaims' in value:claims[side]['claims']=value
                if 'retentionFinish' in value:claims[side]['finish']=value
                if 'retentionWorker' in value:claims[side]['worker']=value
                if 'retentionLifecycle' in value:claims[side]['lifecycle']=value
            assert set(claims[side])=={'claims','finish','worker','lifecycle'}
        assert len(claims)==2 and claims['monolith']==claims['consultation']
        report['retentionClaims']={'matched':True,'finishAndOutbox':True,'workerConnected':True}
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
