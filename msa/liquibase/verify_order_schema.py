"""Order/delivery storage parity against the actual read-only monolith migrations."""
import json


ORDER_TABLES = ('orders', 'order_parcels', 'order_payment_requests',
                'organization_billing_months', 'order_billing_charges', 'empty_ai_order_results', 'order_parcel_drafts')
DELIVERY_TABLES = ('shipments', 'shipment_status_history')
SOURCE_FUNCTIONS = ('valid_parcel_address', 'touch_order_header', 'guard_order_parcel_edit',
                    'touch_order_parcel_parent', 'cancel_order_parcels')


def verify_order_schema(base, sql, report):
    migrations = sorted((base.parents[1] / 'backend/migrations').glob('[0-9][0-9][0-9]-*.sql'))
    assert migrations and migrations[-1].name.startswith('055-'), 'Reconcile the latest source migration contract'
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

    function_names = ','.join("'" + name + "'" for name in SOURCE_FUNCTIONS)
    functions = f"SELECT jsonb_agg(pg_get_functiondef(oid) ORDER BY proname) FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ({function_names});"
    assert sql(source_db, functions, 'source-order-function-contract') == sql('order_db', functions, 'msa-order-function-contract')
