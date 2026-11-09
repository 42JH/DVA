"""Compare production reads and worker-isolated writes on three isolated Docker DBs."""
import json
from pathlib import Path
import subprocess
import time
import uuid
from ci_images import prepared_image

ROOT = Path(__file__).resolve().parents[2]
RUN = 'dva-customer-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN
LOGS = ROOT / 'msa/liquibase/verification-logs/customer'


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    resources = []
    report = {'passed': False, 'checks': [], 'phases': {
        'reads': {'nodeEnv': 'production', 'automaticBusinessWorkers': True},
        'writes': {'nodeEnv': 'test', 'automaticBusinessWorkers': False},
    }, 'reference': subprocess.check_output(
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

    def create(name, image, *args, command=()):
        run('docker', 'create', '--name', name, '--label', LABEL, '--network', RUN,
            *args, image, *command, label=name+'-create')
        resources.append(('container', name))
        if '--test' in command:
            target = '/app/test/' if image == images.get('monolith-checks') else '/app/service/test/'
            run('docker', 'cp', str(ROOT/'msa/parity/fixture-reset.cjs'), name+':'+target+'fixture-reset.cjs',
                label=name+'-copy-fixture-reset')

    def complete(name):
        run('docker', 'start', '--attach', name, label=name+'-run')
        code = run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name+'-exit')
        if code != '0':
            raise RuntimeError(name + ' exited with ' + code)

    password = uuid.uuid4().hex
    auth_token = uuid.uuid4().hex
    try:
        images = {}
        for name, path, target in (
            ('customer-checks', 'msa/services/customer', 'checks'),
            ('customer', 'msa/services/customer', None),
            ('operations', 'msa/services/operations', None),
            ('monolith-checks', 'backend', 'checks'),
            ('monolith', 'backend', None), ('liquibase', 'msa/liquibase', None),
        ):
            image = prepared_image(name)
            if image:
                images[name] = image
                report.setdefault('images', {})[name] = image
                print(name + '-reuse', flush=True)
                continue
            image = RUN + '-' + name
            resources.append(('image', image))
            run('docker', 'build', '--label', LABEL, '-t', image,
                *(['--target', target] if target else []), *(['-f', str(ROOT / path / 'Dockerfile'), str(ROOT / 'msa')] if path.startswith('msa/services/') else [str(ROOT / path)]), label=name+'-build')
            images[name] = image
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        for side in ('monolith', 'operations', 'customer'):
            name = RUN + '-' + side + '-db'
            create(name, 'postgres:17.11-bookworm', '--network-alias', side+'-db',
                   '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER='+side+'_app',
                   '-e', 'POSTGRES_PASSWORD='+password, '-e', 'POSTGRES_DB=dva_webhook_test')
            run('docker', 'start', name, label=side+'-db-start')
            for _ in range(60):
                ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1',
                                        '-U', side+'_app'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError(side+' DB did not become ready')
            if side == 'monolith':
                name = RUN+'-monolith-schema'
                create(name, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_NAME=dva_webhook_test',
                       '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PGHOST=monolith-db', '-e', 'PGUSER=monolith_app',
                       '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password, command=('node', '-e',
                       "const {Pool}=require('pg');const p=new Pool();require('./test/helpers/migrations.cjs').migrate(p).then(()=>p.end(),async e=>{console.error(e.code||'schema-failed');await p.end();process.exit(1)})"))
            else:
                name = RUN+'-'+side+'-schema'
                create(name, images['liquibase'],
                       '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{side}-db:5432/dva_webhook_test',
                       '-e', 'LIQUIBASE_COMMAND_USERNAME='+side+'_app', '-e', 'LIQUIBASE_COMMAND_PASSWORD='+password,
                       command=('--changelog-file='+side+'/db.changelog.xml', 'update'))
            complete(name)
        def applications(mode):
          for side, port in (('monolith', '3000'), ('operations', '3005'), ('customer', '3001')):
            name = RUN+'-'+side+'-app'
            create(name, images[side], '--network-alias', side+'-app',
                   '-e', 'NODE_ENV='+mode, '-e', 'PORT='+port, '-e', 'DB_HOST='+side+'-db',
                   '-e', 'SECURITY_LOG_HMAC_KEY='+uuid.uuid4().hex+uuid.uuid4().hex,
                   '-e', 'DB_USER='+side+'_app', '-e', 'DB_PASSWORD='+password, '-e', 'DB_NAME=dva_webhook_test',
                   '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true',
                   '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'AI_AGENT_URL=http://ai.invalid:8000', '-e', 'OPERATIONS_URL=http://operations-app:3005',
                   '-e', 'CUSTOMER_URL=http://customer-app:3001',
                   '-e', 'CUSTOMER_AUTH_TOKEN='+auth_token)
            run('docker', 'start', name, label=side+'-app-start')
        applications('production')
        run('docker', 'cp', RUN+'-operations-app:/app/service/dist/auth/password.js',
            str(LOGS / 'seed-password.cjs'), label='password-fixture-copy')
        name = RUN+'-differential'
        create(name, images['customer-checks'], '-e', 'NODE_ENV=test',
               '-e', 'AI_BUSINESS_TOKEN='+password, '-e', 'PGPASSWORD='+password, '-e', 'PGDATABASE=dva_webhook_test',
               '-e', 'CUSTOMER_AUTH_TOKEN='+auth_token, command=('node', '--test', '--test-concurrency=1', 'test/member-input.test.cjs', 'test/customer-reads.test.cjs'))
        for source in (ROOT / 'backend/test/member-input.test.cjs', ROOT / 'msa/parity/customer-reads.test.cjs', ROOT / 'msa/parity/customer-writes.test.cjs', LOGS / 'seed-password.cjs'):
            run('docker', 'cp', str(source), name+':/app/service/test/'+source.name, label='copy-'+source.name)
        complete(name)
        # The unchanged monolith's test mode isolates foreground writes from future order workers.
        for side in ('monolith','operations','customer'):
            name = RUN+'-'+side+'-app'
            item = json.loads(run('docker', 'inspect', name, label=side+'-production-owner'))[0]
            if item.get('Config', {}).get('Labels', {}).get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of unowned production fixture: '+name)
            result = subprocess.run(['docker', 'logs', name], capture_output=True, text=True,
                                    encoding='utf-8', errors='replace', check=True)
            (LOGS / (name+'-production.log')).write_text(result.stdout+result.stderr, encoding='utf-8')
            run('docker','rm','-f',name,label=side+'-production-stop')
            resources.remove(('container',name))
        applications('test')
        name = RUN+'-writes'
        create(name, images['customer-checks'], '-e','NODE_ENV=test','-e','AI_BUSINESS_TOKEN='+password, '-e','PGPASSWORD='+password,
               '-e','PGDATABASE=dva_webhook_test','-e','CUSTOMER_AUTH_TOKEN='+auth_token,
               command=('node','--test','test/customer-writes.test.cjs'))
        for source in (ROOT / 'msa/parity/customer-writes.test.cjs', LOGS / 'seed-password.cjs'):
            run('docker','cp',str(source),name+':/app/service/test/'+source.name,label='writes-copy-'+source.name)
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
                result = subprocess.run(['docker', 'logs', name], capture_output=True, text=True, encoding='utf-8')
                (LOGS / (name+'.log')).write_text(result.stdout+result.stderr, encoding='utf-8')
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name, label=name+'-cleanup')
        (LOGS / 'verification.json').write_text(json.dumps(report, indent=2)+'\n', encoding='utf-8')


if __name__ == '__main__':
    main()
