"""Check the initial 052 contract against the current five-owner implementation."""
import io
import json
from pathlib import Path
import subprocess
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
BASELINE = json.loads((ROOT / 'msa/parity/initial-baseline.json').read_text(encoding='utf-8'))
RUN = 'dva-final-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN
LOGS = ROOT / 'msa/liquibase/verification-logs/final' / RUN
SERVICES = {'operations': 3005, 'customer': 3001, 'consultation': 3004, 'delivery': 3003, 'order': 3002}


def main():
    LOGS.mkdir(parents=True)
    resources = []
    report = {'passed': False, 'run': RUN, 'initialCommit': BASELINE['commit'],
              'candidateCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
              'checks': [], 'images': {}, 'unverified': [
                  'Operating Jenkins, DB, cluster, ingress/HTTPS and real external providers',
                  'All valid business branches of all 95 routes',
                  'Global cross-owner retention, payment and order-submission worker recovery',
              ]}

    def run(*args, label, required=True, timeout=900):
        result = subprocess.run(args, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        output = result.stdout.decode('utf-8', 'replace').replace('\r\n', '\n')
        (LOGS / (label + '.log')).write_text(output, encoding='utf-8')
        report['checks'].append({'label': label, 'exitCode': result.returncode})
        print(label + ': ' + str(result.returncode), flush=True)
        if required and result.returncode:
            raise RuntimeError(label + ': ' + output[-5000:])
        return result.returncode, output.strip()

    def create(name, image, *args, command=(), network=RUN):
        run('docker', 'create', '--name', name, '--label', LABEL, '--network', network,
            *args, image, *command, label=name + '-create')
        resources.append(('container', name))

    def complete(name, required=True, timeout=900):
        run('docker', 'start', '--attach', name, label=name + '-run', required=False, timeout=timeout)
        _, code = run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name + '-exit')
        if required and code != '0':
            raise RuntimeError(name + ' exited with ' + code)
        return int(code)

    password, token = uuid.uuid4().hex, uuid.uuid4().hex
    try:
        archive = subprocess.check_output(['git', 'archive', BASELINE['commit'], 'backend', 'infra/database/verify.sql'], cwd=ROOT)
        reference = LOGS / 'reference'
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(reference, filter='data')
        report['referenceTree'] = subprocess.check_output(
            ['git', 'rev-parse', BASELINE['commit'] + ':backend'], cwd=ROOT, text=True).strip()
        _, value = run('node', 'msa/parity/inventory.cjs', str(reference), label='initial-source-inventory')
        if json.loads(value) != BASELINE['inventory']:
            raise RuntimeError('Initial archive inventory differs from the initial plan')
        images = {}
        for owner in ['monolith', *SERVICES]:
            for target in (('checks', None) if owner == 'monolith' else (None,)):
                key = owner + ('-checks' if target else '')
                tag = RUN + '-' + key
                resources.append(('image', tag))
                context = [str(reference / 'backend')] if owner == 'monolith' else [
                    '-f', str(ROOT / 'msa/services' / owner / 'Dockerfile'), str(ROOT / 'msa')]
                run('docker', 'build', '--label', LABEL, '-t', tag,
                    *(['--target', target] if target else []), *context, label=key + '-build')
                images[key] = tag
                report['images'][key] = run('docker', 'image', 'inspect', tag, '--format', '{{.Id}}', label=key + '-image-id')[1]
        images['liquibase'] = RUN + '-liquibase'
        resources.append(('image', images['liquibase']))
        run('docker', 'build', '--label', LABEL, '-t', images['liquibase'], str(ROOT / 'msa/liquibase'), label='liquibase-build')
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        for owner in ['reference-suite', 'monolith', *SERVICES]:
            name = RUN + '-' + owner + '-db'
            create(name, 'postgres:17.11-bookworm', '--network-alias', owner + '-db',
                   '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=test_user',
                   '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=dva_webhook_test')
            run('docker', 'start', name, label=owner + '-db-start')
            for _ in range(60):
                if subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'test_user'],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError(owner + ' DB not ready')
        name = RUN + '-reference-suite'
        create(name, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_HOST=127.0.0.1',
               '-e', 'DB_PORT=5432', '-e', 'DB_USER=test_user', '-e', 'DB_PASSWORD=' + password,
               '-e', 'DB_NAME=dva_webhook_test', '-e', 'AI_AGENT_URL=http://ai.invalid:8000',
               '-e', 'SWAGGER_ENABLED=false', '-e', 'DVA_TEST_DATABASE_VERIFY_SQL=' +
               (reference / 'infra/database/verify.sql').read_text(encoding='utf-8'),
               network='container:' + RUN + '-reference-suite-db')
        reference_suite = name
        for owner in ['monolith', *SERVICES]:
            name = RUN + '-' + owner + '-schema'
            if owner == 'monolith':
                create(name, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'DB_NAME=dva_webhook_test',
                       '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PGHOST=monolith-db', '-e', 'PGUSER=test_user',
                       '-e', 'PGPASSWORD=' + password,
                       command=('node', '-e', "const{Pool}=require('pg');const p=new Pool();require('./test/helpers/migrations.cjs').migrate(p).then(()=>p.end(),async e=>{console.error(e);await p.end();process.exit(1)})"))
            else:
                create(name, images['liquibase'], '-e', f'LIQUIBASE_COMMAND_URL=jdbc:postgresql://{owner}-db:5432/dva_webhook_test',
                       '-e', 'LIQUIBASE_COMMAND_USERNAME=test_user', '-e', 'LIQUIBASE_COMMAND_PASSWORD=' + password,
                       command=('--changelog-file=' + owner + '/db.changelog.xml', 'update'))
            complete(name)
        for owner, port in [('monolith', 3000), *SERVICES.items()]:
            name = RUN + '-' + owner + '-app'
            create(name, images[owner], '--network-alias', owner + '-app', '-e', 'NODE_ENV=test', '-e', 'PORT=' + str(port),
                   '-e', 'DB_HOST=' + owner + '-db', '-e', 'DB_USER=test_user', '-e', 'DB_PASSWORD=' + password,
                   '-e', 'DB_NAME=dva_webhook_test', '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true',
                   '-e', 'AI_AGENT_URL=http://' + ('127.0.0.1' if owner == 'monolith' else 'operations-app') + ':8000',
                   '-e', 'DVER_API_URL=http://127.0.0.1:8000/parcel', '-e', 'DVER_API_KEY=' + password,
                   '-e', 'AI_BUSINESS_TOKEN=' + password,
                   '-e', 'AI_INSIGHTS_TOKEN=' + password, '-e', 'AI_PERSONA_TOKEN=' + password,
                   '-e', 'AI_FAQ_TOKEN=' + password, '-e', 'PBX_WEBHOOK_TOKEN=' + password,
                   '-e', 'OPERATIONS_URL=http://operations-app:3005', '-e', 'CUSTOMER_URL=http://customer-app:3001',
                   '-e', 'CONSULTATION_URL=http://consultation-app:3004', '-e', 'ORDER_URL=http://order-app:3002',
                   '-e', 'DELIVERY_URL=http://delivery-app:3003', '-e', 'CUSTOMER_AUTH_TOKEN=' + password,
                   '-e', 'CONSULTATION_AUTH_TOKEN=' + token)
            run('docker', 'start', name, label=owner + '-app-start')
            if owner in ('monolith', 'operations', 'order'):
                peer = RUN + '-' + owner + '-peer'
                create(peer, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'FINAL_SERVICE_TOKEN=' + password,
                       network='container:' + name, command=('node', 'test/final-peer.cjs'))
                run('docker', 'cp', str(ROOT / 'msa/parity/final-peer.cjs'), peer + ':/app/test/final-peer.cjs', label=owner + '-peer-copy')
                run('docker', 'start', peer, label=owner + '-peer-start')
        name = RUN + '-differential'
        create(name, images['monolith-checks'], '-e', 'NODE_ENV=test', '-e', 'PGUSER=test_user',
               '-e', 'PGPASSWORD=' + password, '-e', 'PGDATABASE=dva_webhook_test', '-e', 'FINAL_SERVICE_TOKEN=' + password,
               command=('node', 'test/final-parity.cjs'))
        for source, destination in [('msa/parity/final-parity.cjs', '/app/test/final-parity.cjs'),
                                    ('msa/parity/initial-baseline.json', '/app/test/initial-baseline.json')]:
            run('docker', 'cp', str(ROOT / source), name + ':' + destination, label='copy-' + Path(source).name)
        report['differentialExitCode'] = complete(name, required=False)
        run('docker', 'cp', name + ':/app/final-parity-report.json', str(LOGS / 'differential.json'), label='differential-report')
        report['differential'] = json.loads((LOGS / 'differential.json').read_text(encoding='utf-8'))
        report['referenceIntegrationExitCode'] = complete(reference_suite, required=False, timeout=1800)
        report['passed'] = (report['referenceIntegrationExitCode'] == 0 and report['differentialExitCode'] == 0
                            and not report['unverified'])
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        for kind, name in reversed(resources):
            result = subprocess.run(['docker', kind, 'inspect', name], capture_output=True)
            if result.returncode:
                continue
            item = json.loads(result.stdout)[0]
            labels = item.get('Labels') if kind == 'network' else item.get('Config', {}).get('Labels')
            if not labels or labels.get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of unowned resource: ' + name)
            if kind == 'container' and name.endswith('-app'):
                output = subprocess.run(['docker', 'logs', name], capture_output=True)
                (LOGS / (name + '.log')).write_text((output.stdout + output.stderr).decode('utf-8', 'replace'), encoding='utf-8')
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name, label=name + '-cleanup')
        (LOGS / 'verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print('REPORT=' + str(LOGS / 'verification.json'), flush=True)
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
