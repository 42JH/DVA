"""Append-only 055 upgrades and all new source columns, constraints, indexes and snapshots."""
import json
import shutil
from functools import partial
import xml.etree.ElementTree as ET


def verify_parcel_draft_schema(base, logs, sql, lb, report):
    source = 'parcel_draft_source_upgrade_db'
    migrations = [p for p in sorted((base.parents[1] / 'backend/migrations').glob('[0-9][0-9][0-9]-*.sql')) if int(p.name[:3]) <= 55]
    assert migrations[-1].name.startswith('055-'), 'The historical upgrade must end at 055'
    # Keep the existing 055 transition independent of later append-only changesets.
    upgrade = logs / '055-upgrade-changelog'
    shutil.copytree(base / 'changelog', upgrade, dirs_exist_ok=True)
    ET.register_namespace('', 'http://www.liquibase.org/xml/ns/dbchangelog')
    for owner, count in (('order', 4), ('consultation', 8)):
        path = upgrade / owner / 'db.changelog.xml'
        tree = ET.parse(path)
        for changeset in list(tree.getroot())[count:]:
            tree.getroot().remove(changeset)
        tree.write(path, encoding='utf-8', xml_declaration=True)
    lb = partial(lb, changelog_root=upgrade)
    sql('postgres', f'CREATE DATABASE {source};', 'draft-source-setup')
    sql(source, 'BEGIN;\n' + '\n'.join(p.read_text(encoding='utf-8') for p in migrations[:-1]) + '\nCOMMIT;', 'draft-source-baseline')
    fixtures = {owner: (base / 'tests' / f'parcel-draft-{owner}-fixture.sql').read_text(encoding='utf-8') for owner in ('orders', 'calls')}
    sql(source, fixtures['orders'] + fixtures['calls'], 'draft-source-old-data')
    snapshots = {
        'order': "SELECT jsonb_build_object('orders',(SELECT jsonb_agg(to_jsonb(t) ORDER BY order_seq) FROM orders t),'parcels',(SELECT jsonb_agg(to_jsonb(t) ORDER BY order_parcel_seq) FROM order_parcels t));",
        'consultation': "SELECT jsonb_agg(to_jsonb(t) ORDER BY call_session_seq) FROM call_sessions t;",
    }
    before = {owner: json.loads(sql(source, query, 'draft-source-before-' + owner)) for owner, query in snapshots.items()}
    sql(source, 'BEGIN;\n' + migrations[-1].read_text(encoding='utf-8') + '\nCOMMIT;', 'draft-source-055')
    assert json.loads(sql(source, snapshots['order'], 'draft-source-original-orders-preserved')) == before['order']
    expected_calls = json.loads(sql(source, snapshots['consultation'], 'draft-source-new-call-columns'))
    expected_drafts = json.loads(sql(source, 'SELECT jsonb_agg(to_jsonb(t) - \'client_parcel_id\' ORDER BY legacy_order_seq,legacy_order_parcel_seq) FROM order_parcel_drafts t;', 'draft-source-copies'))
    for owner, count, file, fixture in (
        ('order', 3, '004-parcel-drafts.sql', 'orders'), ('consultation', 7, '008-order-intake.sql', 'calls'),
    ):
        db = 'parcel_draft_' + owner + '_upgrade_db'
        prefix = 'draft-' + owner
        sql('postgres', f'CREATE DATABASE {db} OWNER {owner}_app;', prefix + '-setup')
        lb(owner, db, 'update-count', prefix + '-baseline', extra=('--count=' + str(count),))
        sql(db, fixtures[fixture], prefix + '-old-data')
        if owner == 'consultation':
            sql(db, "UPDATE call_sessions SET end_reason='LEGACY_COMPLETION' WHERE call_session_seq=200;", prefix + '-retired-end-reason')
        legacy_before = json.loads(sql(db, snapshots[owner], prefix + '-before'))
        expected_before = before[owner]
        if owner == 'consultation':
            expected_before = [{**{k: v for k, v in row.items() if k not in ('purge_claim_id', 'purge_claimed_until')},
                                'end_reason': 'LEGACY_COMPLETION' if row['call_session_seq'] == 200 else None} for row in expected_before]
        assert legacy_before == expected_before
        history = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', prefix + '-old-history')
        failing = logs / ('atomicity-' + prefix)
        shutil.copytree(upgrade, failing, dirs_exist_ok=True)
        migration = failing / owner / file
        migration.write_text(migration.read_text(encoding='utf-8') + '\nSELECT 1/0;\n', encoding='utf-8')
        output = lb(owner, db, 'update', prefix + '-late-failure', failure=True, changelog_root=failing)
        assert 'division by zero' in output.lower(), output
        assert json.loads(sql(db, snapshots[owner], prefix + '-atomic-data')) == legacy_before
        assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', prefix + '-atomic-history') == history
        assert sql(db, "SELECT to_regclass('order_parcel_drafts') IS NULL AND to_regclass('legacy_parcel_draft_bindings') IS NULL AND to_regclass('parcel_draft_migration_state') IS NULL AND to_regclass('legacy_parcel_draft_call_snapshots') IS NULL AND to_regclass('parcel_draft_call_snapshot_state') IS NULL;", prefix + '-atomic-schema') == 't'
        lb(owner, db, 'update', prefix + '-apply')
        assert sql(db, f'SELECT id,md5sum,dateexecuted FROM databasechangelog WHERE orderexecuted<={count} ORDER BY orderexecuted;', prefix + '-history-preserved') == history
        if owner == 'order':
            assert json.loads(sql(db, snapshots[owner], prefix + '-original-preserved')) == before[owner]
            unbound = json.loads(sql(db, 'SELECT jsonb_agg(to_jsonb(t) - \'client_parcel_id\' ORDER BY legacy_order_seq,legacy_order_parcel_seq) FROM order_parcel_drafts t;', prefix + '-copied-data'))
            for row in expected_drafts:
                row['call_session_seq'] = None
                row['caller_phone_number'] = None
            assert unbound == expected_drafts, (unbound, expected_drafts)
            assert sql(db, 'SELECT count(*),count(DISTINCT client_parcel_id),bool_and(version=1 AND creation_payload=\'{}\'::jsonb) FROM order_parcel_drafts;', prefix + '-identities') == '7|7|t'
            assert sql(db, 'SELECT count(*) FROM legacy_parcel_draft_bindings WHERE NOT completed;', prefix + '-pending') == '6'
        else:
            assert json.loads(sql(db, snapshots[owner], prefix + '-calls-parity')) == expected_calls
            expected = sql(source, "SELECT jsonb_agg(jsonb_build_array(order_seq,c,p) ORDER BY order_seq) FROM (SELECT order_seq,CASE WHEN count(*)=1 THEN min(call_session_seq) END c,CASE WHEN count(*)=1 THEN min(caller_phone_number) END p FROM call_sessions GROUP BY order_seq) t;", prefix + '-source-bindings')
            actual = sql(db, 'SELECT jsonb_agg(jsonb_build_array(legacy_order_seq,call_session_seq,caller_phone_number) ORDER BY legacy_order_seq) FROM legacy_parcel_draft_call_snapshots;', prefix + '-captured-bindings')
            assert json.loads(actual) == json.loads(expected)
            assert sql(db, 'SELECT pruned FROM parcel_draft_call_snapshot_state WHERE singleton;', prefix + '-snapshot-open') == 'f'
            new_catalog = """SELECT jsonb_build_object(
              'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname)
                FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
                WHERE a.attrelid='call_sessions'::regclass AND (a.attname LIKE 'order_%' AND a.attname<>'order_seq' OR a.attname IN ('purge_claim_id','purge_claimed_until')) AND NOT a.attisdropped),
              'checks',(SELECT jsonb_agg(pg_get_constraintdef(oid) ORDER BY conname) FROM pg_constraint
                WHERE conrelid='call_sessions'::regclass AND (conname LIKE 'call_order_%' OR conname LIKE '%order_intake_version%' OR conname IN ('call_purge_claim_pair','call_sessions_check'))),
              'index',pg_get_indexdef('call_order_finalization_idx'::regclass));"""
            assert json.loads(sql(db, new_catalog, prefix + '-catalog')) == json.loads(sql(source, new_catalog, prefix + '-source-catalog'))
            sql(db, "INSERT INTO call_sessions(provider_call_id) VALUES('draft-default-check');", prefix + '-new-call')
            assert sql(db, "SELECT order_intake_enabled,order_intake_version FROM call_sessions WHERE provider_call_id='draft-default-check';", prefix + '-new-default') == 't|1'
        current = sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', prefix + '-current-history')
        lb(owner, db, 'update', prefix + '-repeat')
        assert sql(db, 'SELECT id,md5sum,dateexecuted FROM databasechangelog ORDER BY orderexecuted;', prefix + '-repeat-history') == current
    report['parcelDraftStorageSource'] = migrations[-1].name
