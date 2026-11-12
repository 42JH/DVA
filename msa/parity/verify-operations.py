"""Compare operations against the unchanged monolith on disposable Docker DBs."""
import json
import importlib.util
import shutil
from pathlib import Path
import subprocess
import time
import uuid
from ci_images import prepared_image

ROOT = Path(__file__).resolve().parents[2]
RUN = 'dva-operations-check-' + uuid.uuid4().hex[:12]
LABEL = 'dva.test-run=' + RUN
LOGS = ROOT / 'msa/liquibase/verification-logs/operations'


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    resources = []
    report = {'passed': False, 'checks': [], 'reference': subprocess.check_output(
        ['git', 'rev-parse', 'HEAD:backend'], cwd=ROOT, text=True).strip()}

    def run(*args, label, data=None):
        result = subprocess.run(args, input=data, text=True, encoding='utf-8',
                                errors='replace', stdout=subprocess.PIPE,
                                stderr=subprocess.STDOUT, timeout=900, cwd=ROOT)
        (LOGS / (label + '.log')).write_text(result.stdout, encoding='utf-8')
        if result.returncode:
            raise RuntimeError(label + ': ' + result.stdout[-6000:])
        report['checks'].append(label)
        print(label, flush=True)
        return result.stdout.strip()

    def create(name, image, *args, command=()):
        run('docker', 'create', '--name', name, '--label', LABEL, '--network', RUN,
            *args, image, *command, label=name + '-create')
        resources.append(('container', name))
        if '--test' in command and image != images.get('monolith'):
            copy('msa/parity/fixture-reset.cjs', name, '/app/service/test/fixture-reset.cjs')

    def complete(name):
        run('docker', 'start', '--attach', name, label=name + '-run')
        code = run('docker', 'inspect', name, '--format', '{{.State.ExitCode}}', label=name + '-exit')
        if code != '0':
            raise RuntimeError(name + ' exited with ' + code)

    def copy(source, name, destination):
        run('docker', 'cp', str(ROOT / source), name + ':' + destination,
            label=name + '-copy-' + Path(source).name)

    password = uuid.uuid4().hex
    try:
        images = {}
        for name, path, target in (
            ('customer', 'msa/services/customer', None),
            ('operations-checks', 'msa/services/operations', 'checks'),
            ('operations', 'msa/services/operations', None),
            ('consultation', 'msa/services/consultation', None),
            ('monolith', 'backend', None),
            ('liquibase', 'msa/liquibase', None),
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
                *(['--target', target] if target else []), *(['-f', str(ROOT / path / 'Dockerfile'), str(ROOT / 'msa')] if path.startswith('msa/services/') else [str(ROOT / path)]), label=name + '-build')
            images[name] = image
        run('docker', 'network', 'create', '--internal', '--label', LABEL, RUN, label='network')
        resources.append(('network', RUN))
        addresses = {}
        for side in ('monolith', 'operations', 'consultation'):
            name = RUN + '-' + side + '-db'
            create(name, 'postgres:17.11-bookworm', '--network-alias', side + '-db',
                   '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=operations_app',
                   '-e', 'POSTGRES_PASSWORD=' + password, '-e', 'POSTGRES_DB=dva_webhook_test')
            run('docker', 'start', name, label=side + '-db-start')
            for _ in range(60):
                ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1',
                                        '-U', 'operations_app'], stdout=subprocess.DEVNULL,
                                       stderr=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
                time.sleep(1)
            else:
                raise RuntimeError(side + ' DB not ready')
            addresses[side] = run('docker', 'inspect', name, '--format',
                                 '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', label=side + '-db-address')
        name = RUN + '-monolith-schema'
        create(name, images['monolith'], '-e', 'NODE_ENV=test', '-e', 'DB_NAME=dva_webhook_test',
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'PGHOST=monolith-db',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               command=('node', '/app/migrate-reference.cjs'))
        copy('msa/parity/migrate-reference.cjs', name, '/app/migrate-reference.cjs')
        complete(name)
        name = RUN + '-migrate'
        create(name, images['liquibase'],
               '-e', 'LIQUIBASE_COMMAND_URL=jdbc:postgresql://operations-db:5432/dva_webhook_test',
               '-e', 'LIQUIBASE_COMMAND_USERNAME=operations_app',
               '-e', 'LIQUIBASE_COMMAND_PASSWORD=' + password,
               command=('--changelog-file=operations/db.changelog.xml', 'update'))
        complete(name)
        name = RUN + '-consultation-migrate'
        create(name, images['liquibase'],
               '-e', 'LIQUIBASE_COMMAND_URL=jdbc:postgresql://consultation-db:5432/dva_webhook_test',
               '-e', 'LIQUIBASE_COMMAND_USERNAME=operations_app',
               '-e', 'LIQUIBASE_COMMAND_PASSWORD=' + password,
               command=('--changelog-file=consultation/db.changelog.xml', 'update'))
        complete(name)
        fixture = RUN + '-customer-runtime'
        name = RUN + '-fixture-locks'
        create(name, images['operations-checks'], '-e', 'PGHOST=operations-db',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               '-e', 'PGDATABASE=dva_webhook_test',
               command=('node', '--test', 'test/fixture-reset.integration.test.cjs'))
        copy('msa/parity/fixture-reset.integration.test.cjs', name, '/app/service/test/fixture-reset.integration.test.cjs')
        complete(name)
        create(fixture, images['customer'])
        runtime = LOGS / RUN / 'customer-runtime'
        runtime.mkdir(parents=True)
        run('docker', 'cp', fixture + ':/app/service/dist/.', str(runtime), label='customer-runtime')
        common = ['-e', 'DB_USER=operations_app', '-e', 'DB_PASSWORD=' + password,
                  '-e', 'DB_NAME=dva_webhook_test', '-e', 'AI_AGENT_URL=http://ai.invalid:8000',
                  '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true',
                  '-e', 'AUTH_PROXY_HOPS=1', '-e', 'AI_BUSINESS_TOKEN=' + password,
                  '-e', 'SECURITY_LOG_HMAC_KEY=' + uuid.uuid4().hex + uuid.uuid4().hex,
                  '-e', 'CONSULTATION_AUTH_TOKEN=' + password,
                  '-e', 'CONSULTATION_URL=http://consultation-app:3004']
        role_maps = {}
        for side in ('monolith', 'operations'):
            name = RUN + '-' + side + '-role-metadata'
            create(name, images[side], *common, '-e', 'NODE_ENV=test', '-e', 'DB_HOST=db',
                   command=('node', '-e', "require('reflect-metadata');const {adminRoles}=require('./inventory.cjs');console.log(JSON.stringify(adminRoles(require('./dist/app.module').AppModule)))"))
            copy('msa/parity/inventory.cjs', name, '/app/' + ('service/' if side == 'operations' else '') + 'inventory.cjs')
            complete(name)
            role_maps[side] = json.loads(run('docker', 'logs', name, label=side + '-role-map'))
        owned = {route['method'] + ' ' + route['path'] for route in json.loads(
            (ROOT / 'msa/parity/baseline.json').read_text())['inventory']['routes'] if route['service'] == 'operations'}
        expected_roles = {route: roles for route, roles in role_maps['monolith'].items() if route in owned}
        assert len(role_maps['monolith']) == 95 and expected_roles
        assert role_maps['operations'] == expected_roles, 'Operations role metadata differs from the original'
        report['adminRouteRoles'] = role_maps
        name = RUN + '-persona-peer'
        create(name, images['operations-checks'], '--network-alias', 'persona-fixture',
               '-e', 'NODE_ENV=test', '-e', 'AI_PERSONA_TOKEN=' + password,
               command=('node', 'test/persona-fixture.cjs'))
        copy('msa/parity/persona-fixture.cjs', name, '/app/service/test/persona-fixture.cjs')
        run('docker', 'start', name, label='persona-peer-start')
        side = 'operations'
        name = RUN + '-' + side + '-suite'
        create(name, images[side + '-checks'], *common, '--add-host=db:' + addresses[side],
               '-e', 'NODE_ENV=test', '-e', 'DB_HOST=db', command=('node',
               '--require', './test/auth-consumer-fixture.cjs', '--test',
               '--test-concurrency=1', 'test/auth.test.cjs', 'test/auth.integration.test.cjs'))
        run('docker', 'cp', str(runtime), name + ':/app/service/test/customer-runtime', label='auth-consumer-runtime')
        for file in ('auth.test.cjs', 'auth.integration.test.cjs'):
            source = ROOT / 'backend/test' / file
            if file == 'auth.integration.test.cjs':
                # Cross-domain rows do not exist in the operations DB; assert absence instead.
                text = source.read_text(encoding='utf-8')
                for table, alias in (('customers', 'customers'), ('orders', 'orders'), ('call_sessions', 'calls')):
                    original = f'(SELECT count(*) FROM {table}) AS {alias}'
                    assert text.count(original) == 1, 'Source ownership snapshot changed: ' + table
                    text = text.replace(original, f'(SELECT to_regclass(\'{table}\')::text) AS {alias}')
                original = 'assert.equal(routes.size, 95);'
                assert text.count(original) == 1, 'Source administrator route scope changed'
                # Compare public owned routes; MSA health/private event controllers have no monolith counterpart.
                scope = json.dumps(sorted(expected_roles))
                text = text.replace(original, f'''const ownedRoutes = {scope};
  for (const route of routes.keys()) if (!ownedRoutes.includes(route)) routes.delete(route);
  assert.deepEqual([...routes.keys()].sort(), ownedRoutes);
  assert.equal(routes.size, {len(expected_roles)});''')
                source = runtime.parent / file
                source.write_text(text, encoding='utf-8')
            copy(source, name, '/app/service/test/' + file)
        copy('msa/parity/auth-consumer-fixture.cjs', name, '/app/service/test/auth-consumer-fixture.cjs')
        copy('backend/migrations', name, '/app/service/migrations')
        complete(name)
        # Auth bootstrap requires zero administrators; persona fixtures create their own.
        # Run the unchanged suites separately so Node's file sorting cannot reverse them.
        name = RUN + '-' + side + '-persona-suite'
        create(name, images[side + '-checks'], *common, '--add-host=db:' + addresses[side],
               '-e', 'NODE_ENV=test', '-e', 'DB_HOST=db', command=('node',
               '--test', '--test-concurrency=1',
               # Backend cache/request coalescing is explicitly outside this migration.
               '--test-skip-pattern=^(shared option reads isolate callers, expire on settlement and separate rotated credentials|health shares only the upstream probe and checks each caller database independently)$',
               'test/ai-settings.test.cjs', 'test/ai-settings.integration.test.cjs'))
        for file in (ROOT / 'backend/test').glob('ai-settings*.cjs'):
            source = file
            if file.name == 'ai-settings-deletion.cjs':
                text = file.read_text(encoding='utf-8')
                start = text.index("  test('historical and late call analyses retain deleted persona version references'")
                end = text.index("  test('deletion and AI activation serialize", start)
                # This cross-owner case runs through real APIs in call-analysis-parity.
                source = runtime.parent / file.name
                source.write_text(text[:start] + text[end:], encoding='utf-8')
            copy(source, name, '/app/service/test/' + file.name)
        for file in ('helpers/ai-settings.cjs', 'helpers/application.cjs'):
            copy('backend/test/' + file, name, '/app/service/test/' + file)
        copy('backend/migrations', name, '/app/service/migrations')
        complete(name)
        name = RUN + '-' + side + '-faq-suite'
        create(name, images[side + '-checks'], *common, '--add-host=db:' + addresses[side],
               '-e', 'NODE_ENV=test', '-e', 'DB_HOST=db', command=('node', '--test',
               '--test-concurrency=1', 'test/faq-input.test.cjs', 'test/faqs.integration.test.cjs',
               'test/faq-categories.integration.test.cjs', 'test/faq-seed.integration.test.cjs',
               'test/faq-notifications.integration.test.cjs'))
        for file in (ROOT / 'backend/test').glob('faq*.cjs'):
            copy(file.relative_to(ROOT), name, '/app/service/test/' + file.name)
        for file in ('helpers/faqs.cjs', 'helpers/application.cjs'):
            copy('backend/test/' + file, name, '/app/service/test/' + file)
        copy('backend/migrations', name, '/app/service/migrations')
        complete(name)
        for side in ('monolith', 'operations'):
            name = RUN + '-' + side + '-app'
            create(name, images[side], *common, '--network-alias', side + '-app',
                   '--network-alias', side,
                   '-e', 'AI_AGENT_URL=http://persona-fixture:8000/' + side,
                   '-e', 'AI_PERSONA_TOKEN=' + password,
                   '-e', 'NODE_ENV=production', '-e', 'DB_HOST=' + side + '-db', '-e', 'PORT=3005')
            run('docker', 'start', name, label=side + '-app-start')
        name = RUN + '-consultation-app'
        create(name, images['consultation'], '--network-alias', 'consultation-app',
               '-e', 'NODE_ENV=production', '-e', 'DB_HOST=consultation-db',
               '-e', 'DB_USER=operations_app', '-e', 'DB_PASSWORD=' + password,
               '-e', 'DB_NAME=dva_webhook_test', '-e', 'CONSULTATION_AUTH_TOKEN=' + password,
               '-e', 'CUSTOMER_AUTH_TOKEN=' + password, '-e', 'CUSTOMER_URL=http://customer:3001',
               '-e', 'SECURITY_LOG_HMAC_KEY='+uuid.uuid4().hex+uuid.uuid4().hex,
               '-e', 'OPERATIONS_URL=http://operations-app:3005',
               '-e', 'CORS_ORIGINS=http://localhost:5173', '-e', 'SWAGGER_ENABLED=true')
        run('docker', 'start', name, label='faq-consultation-start')
        name = RUN + '-differential'
        create(name, images['operations-checks'], '-e', 'NODE_ENV=test',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               '-e', 'PGDATABASE=dva_webhook_test', command=('node', '--test', 'test/operations-auth.test.cjs'))
        copy('msa/parity/operations-auth.test.cjs', name, '/app/service/test/operations-auth.test.cjs')
        complete(name)
        name = RUN + '-limits-parity'
        create(name, images['operations-checks'], '-e', 'NODE_ENV=test',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               '-e', 'PGDATABASE=dva_webhook_test', command=('node', '--test', 'test/auth-limits-parity.test.cjs'))
        copy('msa/parity/auth-limits-parity.test.cjs', name, '/app/service/test/auth-limits-parity.test.cjs')
        complete(name)
        for side in ('monolith','operations'):
            output=run('docker','logs',RUN+'-'+side+'-app',label=side+'-security-records')
            records=[]
            for line in output.splitlines():
                try: record=json.loads(line)
                except ValueError: continue
                if record.get('event') in ('authentication_success','authentication_failure'):
                    records.append(record)
            assert records and any(r.get('event')=='authentication_success' for r in records)
            assert any(r.get('reason')=='rate_limited' for r in records)
            for record in records:
                assert set(record)<=set(('timestamp','service','environment','level','event','requestId','statusCode','authType','reason','accountKey','sourceKey')),record
                for field in ('accountKey','sourceKey'):
                    if field in record:
                        assert len(record[field])==64 and all(c in 'abcdef0123456789' for c in record[field])
        name = RUN + '-personas'
        create(name, images['operations-checks'], '-e', 'NODE_ENV=test',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'AI_PERSONA_TOKEN=' + password,
               command=('node', '--test', 'test/persona-settings.test.cjs'))
        copy('msa/parity/persona-settings.test.cjs', name, '/app/service/test/persona-settings.test.cjs')
        complete(name)
        run('docker', 'cp', name + ':/app/service/test/persona-before-restart.json',
            str(LOGS / 'persona-before-restart.json'), label='persona-before-restart')
        for side in ('monolith', 'operations'):
            run('docker', 'kill', RUN + '-' + side + '-app', label=side + '-persona-sigkill')
        for side in ('monolith', 'operations'):
            run('docker', 'start', RUN + '-' + side + '-app', label=side + '-persona-restart')
        name = RUN + '-persona-recovery'
        create(name, images['operations-checks'], '-e', 'NODE_ENV=test',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'AI_PERSONA_TOKEN=' + password,
               command=('node', '--test', 'test/persona-recovery.test.cjs'))
        copy('msa/parity/persona-recovery.test.cjs', name, '/app/service/test/persona-recovery.test.cjs')
        run('docker', 'cp', str(LOGS / 'persona-before-restart.json'),
            name + ':/app/service/test/persona-before-restart.json', label='persona-recovery-copy-state')
        complete(name)
        name = RUN + '-faqs'
        create(name, images['operations-checks'], '-e', 'NODE_ENV=test',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'CONSULTATION_AUTH_TOKEN=' + password,
               command=('node', '--test', '--test-name-pattern=^FAQ production', 'test/faqs-parity.test.cjs'))
        copy('msa/parity/faqs-parity.test.cjs', name, '/app/service/test/faqs-parity.test.cjs')
        complete(name)
        # All ordinary API comparisons run with notifications disabled, then use real workers.
        for side in ('monolith', 'operations'):
            run('docker', 'stop', RUN+'-'+side+'-app', label=side+'-faq-stop-before-worker')
            name=RUN+'-'+side+'-faq-app'
            create(name, images[side], *common, '--network-alias', side+'-faq-app',
                   '-e', 'AI_AGENT_URL=http://persona-fixture:8000/'+side,
                   '-e', 'AI_FAQ_TOKEN='+password, '-e', 'NODE_ENV=production',
                   '-e', 'DB_HOST='+side+'-db', '-e', 'PORT=3005')
            run('docker', 'start', name, label=side+'-faq-worker-start')
        name=RUN+'-faq-before-restart'
        create(name, images['operations-checks'], '-e', 'NODE_ENV=test',
               '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD='+password,
               '-e', 'PGDATABASE=dva_webhook_test', '-e', 'AI_FAQ_TOKEN='+password,
               command=('node', '--test', 'test/faq-recovery.test.cjs'))
        copy('msa/parity/faq-recovery.test.cjs',name,'/app/service/test/faq-recovery.test.cjs')
        complete(name)
        for side in ('monolith','operations'):
            run('docker','kill',RUN+'-'+side+'-faq-app',label=side+'-faq-sigkill')
        run('docker','cp',name+':/app/service/test/faq-before-restart.json',str(LOGS/'faq-before-restart.json'),label='faq-before-restart')
        for side in ('monolith','operations'):
            run('docker','start',RUN+'-'+side+'-faq-app',label=side+'-faq-restart')
        name=RUN+'-faq-after-restart'
        create(name,images['operations-checks'],'-e','NODE_ENV=test','-e','PGUSER=operations_app',
               '-e','PGPASSWORD='+password,'-e','PGDATABASE=dva_webhook_test',
               '-e','AI_FAQ_TOKEN='+password,'-e','AI_BUSINESS_TOKEN='+password,'-e','FAQ_RECOVERY=after',
               command=('node','--test','test/faq-recovery.test.cjs'))
        copy('msa/parity/faq-recovery.test.cjs',name,'/app/service/test/faq-recovery.test.cjs')
        run('docker','cp',str(LOGS/'faq-before-restart.json'),name+':/app/service/test/faq-before-restart.json',label='faq-recovery-copy-state')
        complete(name)
        # Leave the usual operation app running for the existing deployment probe.
        run('docker','start',RUN+'-operations-app',label='operations-after-faq-start')
        run('docker','exec',RUN+'-operations-app','node','-e',
            "(async()=>{for(let n=0;n<60;n++){try{if((await fetch('http://127.0.0.1:3005/operations/health/ready')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('restarted app not ready')})().catch(e=>{console.error(e.message);process.exit(1)})",
            label='operations-after-faq-ready')
        spec = importlib.util.spec_from_file_location('app_release', ROOT / 'msa/deploy/app-release.py')
        release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(release)
        # Run the real deployment probe against the production image and its DB readiness route.
        release.kube = lambda *args: run('docker', 'exec', RUN + '-operations-app',
                                        *args[args.index('--') + 1:], label='deployment-probe')
        release.probe('operations', [
            {'kind': 'Deployment', 'spec': {'template': {'spec': {'containers': [
                {'readinessProbe': {'httpGet': {'path': '/operations/health/ready'}}}]}}}},
            {'kind': 'Service', 'spec': {'ports': [{'name': 'http', 'port': 3005}]}},
        ])
        probe = LOGS / 'retention-probe'
        probe.mkdir(exist_ok=True)
        for file in ('faqs-parity.test.cjs', 'fixture-reset.cjs'):
            shutil.copyfile(ROOT / 'msa/parity' / file, probe / file)
        at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        projections = {}
        for phase in ('timer', 'preserves'):
            if phase == 'preserves':
                for app in ('monolith-faq-app', 'operations-faq-app', 'operations-app', 'consultation-app'):
                    run('docker', 'stop', RUN + '-' + app, label=app + '-stop-before-retention')
            for side in ('monolith', 'operations'):
                name = RUN + '-' + side + '-retention-' + phase
                image = images['monolith'] if side == 'monolith' else images['operations-checks']
                create(name, image, '-e', 'NODE_ENV=test', '-e', 'PGHOST=' + side + '-db',
                       '-e', 'PGUSER=operations_app', '-e', 'PGPASSWORD=' + password,
                       '-e', 'PGDATABASE=dva_webhook_test', '-e', 'RETENTION_AT=' + at,
                       command=('node', '--test', '--test-name-pattern=^operations retention ' + phase,
                                'test/faqs-parity.test.cjs'))
                run('docker', 'cp', str(probe) + '/.',
                    name + ':/app/' + ('' if side == 'monolith' else 'service/') + 'test',
                    label=name + '-copy-retention-probe')
                complete(name)
                if phase == 'preserves':
                    output = run('docker', 'logs', name, label=side + '-retention-projection')
                    for line in output.splitlines():
                        try: value = json.loads(line.removeprefix('# '))
                        except ValueError: continue
                        if 'retentionProjection' in value: projections[side] = value
        assert len(projections) == 2 and projections['monolith'] == projections['operations']
        report['operationsRetention'] = {'matched': True, 'expiryBatch': 1000,
                                        'liveTimer': True, 'failureRollback': True}
        report['passed'] = True
    finally:
        for kind, name in reversed(resources):
            result = subprocess.run(['docker', kind, 'inspect', name], capture_output=True, text=True)
            if result.returncode:
                continue  # A failed image build may not have created its image.
            item = json.loads(result.stdout)[0]
            labels = item.get('Config', {}).get('Labels') if kind != 'network' else item.get('Labels')
            if not labels or labels.get('dva.test-run') != RUN:
                raise RuntimeError('Refusing cleanup of unowned resource: ' + name)
            if kind == 'container' and name.endswith('-app'):
                result = subprocess.run(['docker', 'logs', name], capture_output=True, text=True)
                (LOGS / (name + '.log')).write_text(result.stdout + result.stderr, encoding='utf-8')
            run('docker', kind, 'rm', *(['-f'] if kind == 'container' else []), name, label=name + '-cleanup')
        (LOGS / 'verification.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
