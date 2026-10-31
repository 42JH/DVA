\set ON_ERROR_STOP on
BEGIN READ ONLY;
DO $$
DECLARE n integer;
BEGIN
 SELECT count(*) INTO n FROM pg_tables WHERE schemaname='public';
 IF n<>27 THEN RAISE EXCEPTION 'Expected 27 public tables, found %',n; END IF;
 SELECT count(*) INTO n FROM pg_constraint c JOIN pg_namespace s ON s.oid=c.connamespace
 WHERE s.nspname='public' AND c.contype='f';
 IF n<>25 THEN RAISE EXCEPTION 'Expected 25 foreign keys, found %',n; END IF;
 SELECT count(*) INTO n FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
 JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND NOT t.tgisinternal;
 IF n<>10 THEN RAISE EXCEPTION 'Expected 10 business triggers, found %',n; END IF;
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
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public'
  AND table_name='audit_logs' AND column_name IN ('actor_name','target_admin_name'))<>2 THEN
  RAISE EXCEPTION 'Audit name snapshots missing'; END IF;
 IF (SELECT count(*) FROM pg_constraint WHERE contype='f' AND confrelid='admin_users'::regclass)<>1
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='admin_sessions'::regclass
    AND contype='f' AND confrelid='admin_users'::regclass AND confdeltype='c') THEN
  RAISE EXCEPTION 'Only administrator sessions should retain a cascading account FK'; END IF;
 IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='api_idempotency' AND tablename IN ('organization_creations','customer_creations','order_creations','membership_writes')) THEN
  RAISE EXCEPTION 'Obsolete creation receipt tables remain'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='creation_request_id' AND udt_name='uuid') THEN
  RAISE EXCEPTION 'Order creation request UUID missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (creation_request_id)') THEN
  RAISE EXCEPTION 'Order creation request uniqueness missing'; END IF;
 IF to_regclass('pbx_webhooks.call_ended_events') IS NULL THEN RAISE EXCEPTION 'PBX table missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='creation_source' AND is_nullable='NO') THEN
  RAISE EXCEPTION 'Order creation source missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_creation_source_check' AND contype='c') THEN
  RAISE EXCEPTION 'Order creation source constraint missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='incoming_at' AND udt_name='timestamptz') THEN
  RAISE EXCEPTION 'OpenAI incoming event timestamp missing'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='pbx_webhooks' AND table_name='call_ended_events' AND column_name IN ('call_session_seq','last_attempt_at'))<>2 THEN
  RAISE EXCEPTION 'Recording correlation/retry columns missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='pbx_webhooks.call_ended_events'::regclass AND contype='f' AND confrelid='public.call_sessions'::regclass) THEN
  RAISE EXCEPTION 'PBX call correlation foreign key missing'; END IF;
 IF (SELECT count(*) FROM db_migrations.applied_versions
  WHERE version IN ('001-pbx-call-ended.sql','002-monolith-initial.sql','003-admin-auth-sessions.sql','004-organization-creation-requests.sql','005-customer-creation-requests.sql','007-order-creation-requests.sql','008-simplify-creation-requests.sql','009-membership-write-requests.sql','010-remove-membership-write-requests.sql','011-call-recording-correlation.sql','012-order-creation-source.sql','013-ai-persona-versions.sql','014-order-cancellation.sql','015-admin-deletion-audit.sql','016-order-pricing-audit.sql','017-department-billing-policy.sql','018-order-payment-flow.sql','019-organization-monthly-billing.sql','020-faq-change-notifications.sql','021-company-deletion-history.sql','022-order-toss-payments.sql','023-payment-completion-notifications.sql','024-call-analyses.sql','025-call-analysis-seconds.sql','026-call-insight-events.sql','027-faq-categories.sql','028-customer-address-optional-department.sql'))<>27 THEN
  RAISE EXCEPTION 'Migration ledger incomplete'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='address_data' AND udt_name='jsonb' AND is_nullable='YES')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='customers'::regclass AND conname='customers_address_data_check')
  OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memberships' AND column_name='department_seq' AND is_nullable='YES') THEN
  RAISE EXCEPTION 'Customer address or optional department schema missing'; END IF;
 IF to_regclass('public.ai_persona_versions') IS NULL OR to_regclass('public.ai_prompt_versions') IS NOT NULL
  OR to_regclass('public.ai_persona_live_status_uk') IS NULL THEN
  RAISE EXCEPTION 'Persona version schema missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
  AND table_name='order_parcels' AND column_name='status' AND is_nullable='NO')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='orders'::regclass AND conname='orders_receipt_status_check') THEN
  RAISE EXCEPTION 'Order cancellation schema missing'; END IF;
 IF to_regclass('public.faq_change_notifications') IS NULL
  OR to_regclass('public.faq_change_notifications_pending_idx') IS NULL THEN
  RAISE EXCEPTION 'FAQ notification queue or pending index missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='billing_organization_name')
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='company_pins'::regclass AND conname='company_pins_department_company_fk')
  OR EXISTS(SELECT 1 FROM pg_constraint WHERE contype='f' AND conrelid IN ('orders'::regclass,'order_billing_charges'::regclass,'organization_billing_months'::regclass) AND confrelid IN ('organizations'::regclass,'departments'::regclass)) THEN
  RAISE EXCEPTION 'Company deletion history/department PIN schema missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM db_migrations.applied_versions WHERE version='021-company-deletion-history.sql') THEN
  RAISE EXCEPTION 'Company deletion migration missing'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='order_payment_requests'
  AND column_name IN ('provider_payment_key','provider_approved_at','approval_claim_id','approval_claimed_until','notification_status','notification_attempted_at','notification_sent_at'))<>7
  OR to_regclass('public.order_payment_notification_pending_idx') IS NULL OR to_regclass('public.order_payment_reconcile_idx') IS NULL THEN
  RAISE EXCEPTION 'Order payment provider/notification schema missing'; END IF;
 IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='order_payment_requests'
  AND column_name IN ('completion_notification_status','completion_notification_attempted_at','completion_notification_sent_at'))<>3
  OR to_regclass('public.order_payment_completion_pending_idx') IS NULL THEN
  RAISE EXCEPTION 'Payment completion notification schema missing'; END IF;
 IF to_regclass('public.call_insight_events') IS NULL OR to_regclass('public.unanswered_questions') IS NULL THEN
  RAISE EXCEPTION 'Call events or unanswered reference schema missing'; END IF;
 IF to_regclass('public.call_analyses') IS NULL
  OR (SELECT count(*) FROM pg_constraint WHERE conrelid='public.call_analyses'::regclass AND contype='f')<>2
  OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.call_analyses'::regclass AND contype='p'
    AND pg_get_constraintdef(oid)='PRIMARY KEY (call_session_seq)') THEN
  RAISE EXCEPTION 'Call analysis table, identity or foreign keys missing'; END IF;
 RAISE NOTICE 'PASS: 27 public tables, 25 FKs, 10 triggers, employee identity, generated columns and migration ledger';
END $$;
SELECT version,sha256,applied_at FROM db_migrations.applied_versions ORDER BY version;
SELECT schemaname,tablename FROM pg_tables
 WHERE schemaname IN ('public','pbx_webhooks','db_migrations','api_idempotency') ORDER BY schemaname,tablename;
SELECT count(*) AS pbx_receipt_count FROM pbx_webhooks.call_ended_events;
COMMIT;
