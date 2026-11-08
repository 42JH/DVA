"""Real owner HTTP migration and SIGKILL/ACK-loss recovery in separate test DBs."""


def verify_parcel_draft_upgrade(root, run_id, images, password, token, run, create, complete):
    database = 'dva_parcel_draft_test'
    for owner in ('monolith', 'order', 'consultation'):
        run('docker', 'exec', run_id + '-' + owner + '-db', 'psql', '-X', '-U', owner + '_app',
            '-d', 'dva_webhook_test', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE ' + database, label='draft-' + owner + '-database')
    name = run_id + '-draft-upgrade-fixtures'
    create(name, images['order-checks'], '-e', 'NODE_ENV=test', '-e', 'PGDATABASE=' + database,
           '-e', 'PGPASSWORD=' + password, command=('node', 'test/parcel-draft-upgrade.cjs'))
    for source, target in ((root / 'backend/migrations', '/reference-migrations'), (root / 'msa/liquibase/changelog', '/changelog'),
                           (root / 'msa/liquibase/tests', '/fixtures'), (root / 'msa/parity/parcel-draft-upgrade.cjs', '/app/service/test/parcel-draft-upgrade.cjs')):
        run('docker', 'cp', str(source), name + ':' + target, label='draft-fixture-copy-' + source.name)
    complete(name)
    for owner, port in (('consultation', 3004), ('order', 3002)):
        name = run_id + '-' + owner + '-draft-app'
        create(name, images[owner], '--network-alias', owner + '-draft-app', '-e', 'NODE_ENV=test', '-e', 'PORT=' + str(port),
               '-e', 'DB_HOST=' + owner + '-db', '-e', 'DB_USER=' + owner + '_app', '-e', 'DB_PASSWORD=' + password, '-e', 'DB_NAME=' + database,
               '-e', 'SWAGGER_ENABLED=true', '-e', 'OPERATIONS_URL=http://operations-app:3005', '-e', 'CUSTOMER_URL=http://customer-app:3001',
               '-e', 'CONSULTATION_URL=http://consultation-draft-app:3004', '-e', 'ORDER_URL=http://order-draft-app:3002',
               '-e', 'DELIVERY_URL=http://delivery-app:3003', '-e', 'CUSTOMER_AUTH_TOKEN=' + password, '-e', 'CONSULTATION_AUTH_TOKEN=' + token)
        run('docker', 'start', name, label='draft-' + owner + '-start')
        if owner == 'consultation':
            run('docker', 'exec', name, 'node', '-e', "(async()=>{for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:3004/consultation/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('consultation startup unavailable')})().catch(()=>process.exit(1))", label='draft-consultation-startup')
    name = run_id + '-draft-migration-recovery'
    create(name, images['order-checks'], '-e', 'NODE_ENV=test', '-e', 'PGDATABASE=' + database, '-e', 'PGPASSWORD=' + password,
           '-e', 'CUSTOMER_AUTH_TOKEN=' + password, command=('node', '--test', 'test/parcel-draft-migration.test.cjs'))
    for file in ('parcel-draft-migration.test.cjs', 'parcel-draft-migration-claimant.cjs'):
        run('docker', 'cp', str(root / 'msa/parity' / file), name + ':/app/service/test/' + file, label='draft-copy-' + file)
    run('docker', 'cp', str(root / 'backend/src/retention/retention.repository.ts'), name + ':/reference-retention.ts', label='draft-copy-source-retention')
    complete(name)
