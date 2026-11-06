"""Order/delivery storage parity against the actual read-only monolith migrations."""
import json
import shutil


ORDER_TABLES = ('orders', 'order_parcels', 'order_payment_requests',
                'organization_billing_months', 'order_billing_charges', 'empty_ai_order_results')
DELIVERY_TABLES = ('shipments', 'shipment_status_history')
SOURCE_FUNCTIONS = ('valid_parcel_address', 'touch_order_header', 'guard_order_parcel_edit',
                    'touch_order_parcel_parent', 'cancel_order_parcels')


def verify_order_schema(base, logs, sql, lb, report):
    migrations = sorted((base.parents[1] / 'backend/migrations').glob('[0-9][0-9][0-9]-*.sql'))
    assert migrations and migrations[-1].name.startswith('054-'), 'Reconcile the latest source migration contract'
    report['orderStorageSourceMigrations'] = [p.name for p in migrations]

    def apply_source(db, files, label):
        sql(db, 'BEGIN;\n' + '\n'.join(p.read_text(encoding='utf-8') for p in files) + '\nCOMMIT;', label)

    # Constraint names differ in the initial MSA. Compare their complete definitions.
    # Only the two explicitly identified foreign-owner FKs are omitted from source.
    def catalog(db, table, label, source=False):
        remote = "AND conname NOT IN ('orders_customer_seq_fk','shipments_order_parcel_seq_fk')" if source else ''
        return json.loads(sql(db, f"""SELECT jsonb_build_object(
          'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
            a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname)
            FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
            WHERE a.attrelid='{table}'::regclass AND a.attnum>0 AND NOT a.attisdropped),
          'constraints',(SELECT jsonb_agg(def ORDER BY def) FROM
            (SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid='{table}'::regclass {remote}) c),
          'indexes',(SELECT jsonb_agg(indexdef ORDER BY indexdef) FROM pg_indexes
            WHERE schemaname='public' AND tablename='{table}'),
          'triggers',(SELECT jsonb_agg(pg_get_triggerdef(oid) ORDER BY tgname)
            FROM pg_trigger WHERE tgrelid='{table}'::regclass AND NOT tgisinternal));""", label))

    source_db = 'order_storage_source_db'
    sql('postgres', f'CREATE DATABASE {source_db};', 'order-source-setup')
    apply_source(source_db, migrations, 'order-source-all-migrations')
    order_relations = ','.join("'" + table + "'::regclass" for table in ORDER_TABLES)
    delivery_relations = ','.join("'" + table + "'::regclass" for table in DELIVERY_TABLES)
    remote = sql(source_db, f"""SELECT string_agg(conname,',' ORDER BY conname) FROM pg_constraint
      WHERE contype='f' AND conrelid IN ('orders'::regclass,'order_parcels'::regclass,
        'order_payment_requests'::regclass,'organization_billing_months'::regclass,
        'order_billing_charges'::regclass,'empty_ai_order_results'::regclass,
        'shipments'::regclass,'shipment_status_history'::regclass)
      AND ((conrelid IN ({order_relations}) AND confrelid NOT IN ({order_relations}))
        OR (conrelid IN ({delivery_relations}) AND confrelid NOT IN ({delivery_relations})));""", 'order-source-external-fks')
    assert remote == 'orders_customer_seq_fk,shipments_order_parcel_seq_fk', remote
    for service, tables, check in (
        ('order', ORDER_TABLES, 'order-storage-check.sql'),
        ('delivery', DELIVERY_TABLES, 'delivery-storage-check.sql'),
    ):
        for table in tables:
            expected = catalog(source_db, table, 'source-catalog-' + table, True)
            actual = catalog(service + '_db', table, 'msa-catalog-' + table)
            assert actual == expected, (table, expected, actual)
        sql(source_db, (base / 'tests' / check).read_text(encoding='utf-8'), service + '-source-storage-workflow')

    function_names = ','.join("'" + name + "'" for name in SOURCE_FUNCTIONS)
    functions = f"SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY proname) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ({function_names});"
    assert sql(source_db, functions, 'source-order-function-contract') == sql('order_db', functions, 'msa-order-function-contract')

    fixture = """INSERT INTO orders(order_seq,customer_seq,payment_method_type,pickup_requested_at)
      OVERRIDING SYSTEM VALUE VALUES(501,321,'credit','2026-11-30T10:00:00Z'),(502,321,'billing',NULL);
      INSERT INTO order_parcels(order_parcel_seq,order_seq,parcel_position,
        origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_detail_address,
        origin_dong_name,origin_postal_code,origin_latitude,origin_longitude,origin_pin_scope,origin_pin_seq,
        destination_name,destination_phone_number,destination_road_address,destination_jibun_address,
        destination_dong_name,destination_postal_code,destination_latitude,destination_longitude,
        small_box_count,client_comment,item_price)
      OVERRIDING SYSTEM VALUE SELECT p,o,1,'sender','01011112222','road','lot','detail','dong','12345',37,127,'PERSONAL',77,
        'recipient','01022223333','destination road','destination lot','destination dong','54321',38,128,2,'kept',10000
      FROM (VALUES(601,501),(602,502)) v(p,o);
      UPDATE orders SET status='CANCELLED' WHERE order_seq=502;
      ALTER TABLE orders DISABLE TRIGGER USER;
      UPDATE orders SET version=CASE WHEN order_seq=501 THEN 23 ELSE 42 END,
        created_at='2026-10-15T01:00:00Z',updated_at='2026-10-20T02:00:00Z';
      ALTER TABLE orders ENABLE TRIGGER USER;
      SELECT setval(pg_get_serial_sequence('orders','order_seq'),900);
      SELECT setval(pg_get_serial_sequence('order_parcels','order_parcel_seq'),1900);"""
    upgraded_source = 'order_storage_source_upgrade_db'
    sql('postgres', f'CREATE DATABASE {upgraded_source};', 'order-source-upgrade-setup')
    apply_source(upgraded_source, [p for p in migrations if p.name[:3] <= '002'], 'order-source-old-schema')
    sql(upgraded_source, "INSERT INTO customers(customer_seq,name,phone_number,status) OVERRIDING SYSTEM VALUE VALUES(321,'source customer','01099998888','ACTIVE');" + fixture, 'order-source-old-data')
    apply_source(upgraded_source, [p for p in migrations if p.name[:3] > '002'], 'order-source-populated-upgrade')
    business = """SELECT jsonb_build_object('orders',(SELECT jsonb_agg(to_jsonb(o) ORDER BY order_seq) FROM orders o),
      'parcels',(SELECT jsonb_agg(to_jsonb(p) ORDER BY order_parcel_seq) FROM order_parcels p));"""
    expected_business = json.loads(sql(upgraded_source, business, 'order-source-upgraded-data'))

    events = """INSERT INTO outbox_events(event_id,destination,event_type,aggregate_seq,payload,
      occurred_at,next_attempt_at,attempt_count,last_http_status)
      VALUES('00000000-0000-4000-8000-000000000301','delivery','OrderAccepted',501,'{"legacy":true}',
        '2026-10-20T01:00:00Z','2026-10-20T02:00:00Z',2,503);
      INSERT INTO inbox_events(event_id,source,event_type,payload,processed_at)
      VALUES('00000000-0000-4000-8000-000000000302','order','LegacyCommand','{"legacy":true}','2026-10-20T01:00:00Z');"""
    event_snapshot = """SELECT jsonb_build_object('outbox',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM outbox_events e),
      'inbox',(SELECT jsonb_agg(to_jsonb(e) ORDER BY event_id) FROM inbox_events e));"""
    history_sql = 'SELECT id,author,filename,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;'
    all_functions = "SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY proname) FROM pg_proc WHERE pronamespace='public'::regnamespace;"
    for service, filename, old_tables, check in (
        ('order', '003-payment-order-schema.sql', ('orders', 'order_parcels'), 'order-storage-check.sql'),
        ('delivery', '003-shipment-actor-schema.sql', DELIVERY_TABLES, 'delivery-storage-check.sql'),
    ):
        prefix = service + '-storage-upgrade'
        db = service + '_storage_upgrade_db'
        sql('postgres', f'CREATE DATABASE {db} OWNER {service}_app;', prefix + '-setup')
        lb(service, db, 'update-count', prefix + '-baseline', extra=('--count=2',))
        # Keep the original workflow tests intact on their supported schema.
        sql(db, (base / 'tests' / (service + '-workflow-check.sql')).read_text(encoding='utf-8'), prefix + '-legacy-workflow', service + '_app')
        if service == 'order':
            sql(db, fixture, prefix + '-seed', 'order_app')
            snapshot = business
        else:
            sql(db, """INSERT INTO shipments(shipment_seq,order_parcel_seq,tracking_number,status,version,status_changed_at,created_at)
              OVERRIDING SYSTEM VALUE VALUES(701,601,'DVA-legacy-unpaid','notPaid',3,'2026-10-20T00:00:00Z','2026-10-15T00:00:00Z'),
                (702,602,'DVA-legacy-paid','paid',7,'2026-10-20T00:00:00Z','2026-10-15T00:00:00Z');
              INSERT INTO shipment_status_history(shipment_status_history_seq,shipment_seq,request_id,from_status,to_status,actor_type,actor_admin_user_seq,occurred_at)
              OVERRIDING SYSTEM VALUE VALUES(801,701,'00000000-0000-4000-8000-000000000303',NULL,'notPaid','SYSTEM',NULL,'2026-10-15T00:00:00Z'),
                (802,702,'00000000-0000-4000-8000-000000000304','notPaid','paid','ADMIN',998877,'2026-10-20T00:00:00Z');
              SELECT setval(pg_get_serial_sequence('shipments','shipment_seq'),900);
              SELECT setval(pg_get_serial_sequence('shipment_status_history','shipment_status_history_seq'),1900);""", prefix + '-seed', 'delivery_app')
            snapshot = """SELECT jsonb_build_object('shipments',(SELECT jsonb_agg(to_jsonb(s) ORDER BY shipment_seq) FROM shipments s),
              'history',(SELECT jsonb_agg(to_jsonb(h) ORDER BY shipment_status_history_seq) FROM shipment_status_history h));"""
        sql(db, events, prefix + '-event-seed', service + '_app')
        before = sql(db, snapshot, prefix + '-before')
        event_before = sql(db, event_snapshot, prefix + '-events-before')
        history = sql(db, history_sql, prefix + '-history-before')
        old_catalog = [catalog(db, t, prefix + '-before-' + t) for t in old_tables]
        old_functions = sql(db, all_functions, prefix + '-functions-before')

        if service == 'order':
            # Each old submitted state is explicitly refused, including EXPIRED.
            for state in ('SUBMITTING', 'ACCEPTED', 'AUTH_FAILED', 'REVIEW_REQUIRED', 'EXPIRED'):
                sql(db, f"""ALTER TABLE orders DISABLE TRIGGER USER;
                  UPDATE orders SET status='{state}',parcel_no=CASE WHEN '{state}'='ACCEPTED' THEN 'ABC12345' END,
                    dver_received_at=CASE WHEN '{state}'='ACCEPTED' THEN '2026-10-20T00:00:00Z'::timestamptz END WHERE order_seq=501;
                  ALTER TABLE orders ENABLE TRIGGER USER;""", prefix + '-' + state + '-seed', 'order_app')
                refused = sql(db, snapshot, prefix + '-' + state + '-before')
                output = lb(service, db, 'update', prefix + '-' + state + '-rejected', failure=True)
                assert 'Reconcile legacy submitted orders' in output, output
                assert sql(db, snapshot, prefix + '-' + state + '-preserved') == refused
                assert sql(db, history_sql, prefix + '-' + state + '-history') == history
            sql(db, """ALTER TABLE orders DISABLE TRIGGER USER;
              UPDATE orders SET status='COLLECTING',parcel_no=NULL,dver_received_at=NULL WHERE order_seq=501;
              ALTER TABLE orders ENABLE TRIGGER USER;""", prefix + '-restore-test-fixture', 'order_app')

        failing = logs / ('atomicity-storage-' + service)
        shutil.copytree(base / 'changelog', failing, dirs_exist_ok=True)
        migration = failing / service / filename
        migration.write_text(migration.read_text(encoding='utf-8') + '\nSELECT 1/0;\n', encoding='utf-8')
        output = lb(service, db, 'update', prefix + '-late-failure', failure=True, changelog_root=failing)
        assert 'division by zero' in output.lower(), output
        assert sql(db, snapshot, prefix + '-atomic-data') == before
        assert sql(db, event_snapshot, prefix + '-atomic-events') == event_before
        assert sql(db, history_sql, prefix + '-atomic-history') == history
        assert [catalog(db, t, prefix + '-atomic-' + t) for t in old_tables] == old_catalog
        assert sql(db, all_functions, prefix + '-atomic-functions') == old_functions
        assert sql(db, "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('databasechangelog','databasechangeloglock');", prefix + '-atomic-tables') == '4'
        lb(service, db, 'update', prefix + '-apply')
        if service == 'order':
            assert json.loads(sql(db, snapshot, prefix + '-source-data-parity')) == expected_business
            assert sql(db, 'SELECT (SELECT count(*) FROM order_payment_requests),(SELECT count(*) FROM order_billing_charges),(SELECT count(*) FROM organization_billing_months),(SELECT count(*) FROM empty_ai_order_results);', prefix + '-no-invented-history') == '0|0|0|0'
            sequence_tables = ('orders', 'order_parcels')
        else:
            assert sql(db, snapshot, prefix + '-data-preserved') == before
            sequence_tables = ('shipments', 'shipment_status_history')
        assert sql(db, event_snapshot, prefix + '-events-preserved') == event_before
        assert sql(db, history_sql.replace('ORDER BY', 'WHERE orderexecuted<=2 ORDER BY'), prefix + '-history-preserved') == history
        for table, expected in zip(sequence_tables, (901, 1901)):
            key = {'orders': 'order_seq', 'order_parcels': 'order_parcel_seq', 'shipments': 'shipment_seq', 'shipment_status_history': 'shipment_status_history_seq'}[table]
            assert sql(db, f"SELECT nextval(pg_get_serial_sequence('{table}','{key}'));", prefix + '-sequence-' + table) == str(expected)
        sql(db, (base / 'tests' / check).read_text(encoding='utf-8'), prefix + '-workflow', service + '_app')
        current = sql(db, history_sql, prefix + '-history-current')
        lb(service, db, 'update', prefix + '-repeat')
        assert sql(db, history_sql, prefix + '-history-repeat') == current
