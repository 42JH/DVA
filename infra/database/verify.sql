\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_tables WHERE schemaname='public';
 IF n<>19 THEN RAISE EXCEPTION 'Expected 19 public tables, found %',n; END IF;
 SELECT count(*) INTO n FROM pg_constraint c JOIN pg_namespace s ON s.oid=c.connamespace
 WHERE s.nspname='public' AND c.contype='f';
 IF n<>18 THEN RAISE EXCEPTION 'Expected 18 foreign keys, found %',n; END IF;
 SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND NOT t.tgisinternal;
 IF n<>9 THEN RAISE EXCEPTION 'Expected 9 business triggers, found %',n; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_namespace s ON s.oid=c.connamespace
  WHERE s.nspname='public' AND NOT c.convalidated) THEN RAISE EXCEPTION 'Unvalidated constraints found'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
  AND table_name='memberships' AND column_name='employee_no' AND is_nullable='NO') THEN
  RAISE EXCEPTION 'Required employee number column missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.memberships'::regclass
  AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (organization_seq, employee_no)') THEN
  RAISE EXCEPTION 'Organization/employee uniqueness missing'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
  AND table_name IN ('personal_pins','company_pins') AND column_name='search_text' AND is_generated='ALWAYS')<>2 THEN
  RAISE EXCEPTION 'Generated PIN search columns missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='admin_users' AND column_name='name' AND is_nullable='NO') THEN RAISE EXCEPTION 'Admin name missing'; END IF;
 IF to_regclass('public.admin_sessions') IS NULL THEN RAISE EXCEPTION 'Admin sessions missing'; END IF;
 IF to_regclass('api_idempotency.organization_creations') IS NULL THEN RAISE EXCEPTION 'Organization creation receipts missing'; END IF;
 IF to_regclass('pbx_webhooks.call_ended_events') IS NULL THEN RAISE EXCEPTION 'PBX table missing'; END IF;
 IF (SELECT count(*) FROM db_migrations.applied_versions
  WHERE version IN ('001-pbx-call-ended.sql','002-monolith-initial.sql','003-admin-auth-sessions.sql','004-organization-creation-requests.sql'))<>4 THEN
  RAISE EXCEPTION 'Migration ledger incomplete'; END IF;
 RAISE NOTICE 'PASS: 19 public tables, 18 FKs, 9 triggers, employee identity, generated columns and migration ledger';
END $$;
SELECT version,sha256,applied_at FROM db_migrations.applied_versions ORDER BY version;
SELECT schemaname,tablename FROM pg_tables
 WHERE schemaname IN ('public','pbx_webhooks','db_migrations','api_idempotency') ORDER BY schemaname,tablename;
SELECT count(*) AS pbx_receipt_count FROM pbx_webhooks.call_ended_events;
COMMIT;
