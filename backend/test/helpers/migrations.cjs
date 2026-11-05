const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

// 테스트 전용 빈 DB에 실제 migration 전체를 적용한다. 운영 DB에서는 호출하지 않는다.
async function migrate(pool) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if ((await client.query("SELECT to_regclass('public.admin_users') AS name")).rows[0].name) {
      const latest = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='billing_organization_name' AND to_regclass('public.order_billing_charges') IS NOT NULL AND to_regclass('public.faq_change_notifications') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_payment_requests' AND column_name='completion_notification_status')",
      );
      assert.equal(latest.rowCount, 1, 'Use an empty isolated DB or apply all migrations first');
      const events = await client.query(
        "SELECT 1 WHERE to_regclass('public.call_analyses') IS NOT NULL AND to_regclass('public.call_insight_events') IS NOT NULL AND to_regclass('public.unanswered_questions') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='faq_entries' AND column_name='category' AND is_nullable='NO') AND to_regclass('public.faq_entries_question_identity_uq') IS NOT NULL",
      );
      assert.equal(events.rowCount, 1, 'Apply migrations through 029 to the isolated DB first');
      const adminEdit = await client.query(
        "SELECT 1 WHERE pg_get_functiondef('guard_order_parcel_edit()'::regprocedure) LIKE '%dva.admin_order_edit%'",
      );
      assert.equal(adminEdit.rowCount, 1, 'Apply migration 030 to the isolated DB first');
      const recordingClaims = await client.query(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='pbx_webhooks.call_ended_events'::regclass AND conname='call_ended_claim_pair_check')",
      );
      assert.equal(recordingClaims.rowCount, 1, 'Apply migration 031 to the isolated DB first');
      const listIndexes = await client.query(
        "SELECT 1 WHERE to_regclass('public.call_sessions_started_list_idx') IS NOT NULL AND to_regclass('public.orders_customer_created_list_idx') IS NOT NULL",
      );
      assert.equal(listIndexes.rowCount, 1, 'Apply migration 032 to the isolated DB first');
      const registrationDates = await client.query(
        "SELECT 1 WHERE (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('organizations','departments') AND column_name='created_at' AND udt_name='timestamptz' AND is_nullable='YES' AND column_default IS NOT NULL)=2",
      );
      assert.equal(registrationDates.rowCount, 1, 'Apply migration 033 to the isolated DB first');
      const customerMembership = await client.query(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='address_data' AND udt_name='jsonb') AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memberships' AND column_name='department_seq' AND is_nullable='YES')",
      );
      assert.equal(customerMembership.rowCount, 1, 'Apply migration 028 to the isolated DB first');
      const undecidedPayment = await client.query(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='payment_method_type' AND is_nullable='YES' AND column_default IS NULL) AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.orders'::regclass AND conname='orders_payment_method_required_check')",
      );
      assert.equal(undecidedPayment.rowCount, 1, 'Apply migration 037 to the isolated DB first');
      assert.ok(
        (await client.query("SELECT to_regclass('public.empty_ai_order_results') AS name")).rows[0]
          .name,
        'Apply migration 038 to the isolated DB first',
      );
      assert.ok(
        (await client.query("SELECT to_regclass('public.ai_persona_drafts') AS name")).rows[0].name,
        'Apply migration 039 to the isolated DB first',
      );
      const callCustomer = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='customer_seq' AND udt_name='int4' AND is_nullable='YES'",
      );
      assert.equal(callCustomer.rowCount, 1, 'Apply migration 040 to the isolated DB first');
      const callSummary = await client.query(
        "SELECT 1 WHERE (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='call_analyses' AND column_name IN ('is_new_customer','registered_parcel_count','faq_answer_count','order_lookup_count','cancelled_parcel_count','has_handoff_request') AND is_nullable='YES' AND column_default IS NULL)=6",
      );
      assert.equal(callSummary.rowCount, 1, 'Apply migration 041 to the isolated DB first');
      const noAnalysisResult = await client.query(
        "SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_analyses' AND column_name='result')",
      );
      assert.equal(noAnalysisResult.rowCount, 1, 'Apply migration 042 to the isolated DB first');
      const noCoordinates = await client.query(
        'SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=\'public\' AND table_name=\'order_parcels\' AND column_name IN (\'origin_latitude\',\'origin_longitude\',\'destination_latitude\',\'destination_longitude\')) AND valid_customer_address(\'{"roadAddress":"Road","jibunAddress":"Lot","dongName":"Dong","postalCode":"01234"}\'::jsonb)',
      );
      assert.equal(noCoordinates.rowCount, 1, 'Apply migration 043 to the isolated DB first');
      const activeCalls = await client.query(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='registered_at' AND is_nullable='YES' AND column_default IS NOT NULL) AND to_regclass('public.call_sessions_active_count_idx') IS NOT NULL AND to_regclass('pbx_webhooks.call_ended_unlinked_identity_idx') IS NOT NULL",
      );
      assert.equal(activeCalls.rowCount, 1, 'Apply migration 044 to the isolated DB first');
      const retention = await client.query(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_sessions' AND column_name='deleted_at') AND to_regclass('public.orders_retention_idx') IS NOT NULL",
      );
      assert.equal(retention.rowCount, 1, 'Apply migration 045 to the isolated DB first');
      const submissionRetry = await client.query(
        "SELECT 1 WHERE (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name IN ('submission_first_attempt_at','submission_last_attempt_at') AND udt_name='timestamptz' AND is_nullable='YES')=2 AND to_regclass('public.orders_submission_retry_idx') IS NOT NULL",
      );
      assert.equal(submissionRetry.rowCount, 1, 'Apply migration 046 to the isolated DB first');
      const unusedSchema = await client.query(
        "SELECT 1 WHERE to_regclass('public.handoff_requests') IS NULL AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND ((table_name='company_pins' AND column_name='search_text') OR (table_name='call_sessions' AND column_name='end_reason')))",
      );
      assert.equal(unusedSchema.rowCount, 1, 'Apply migration 047 to the isolated DB first');
      const callback = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='call_analyses' AND column_name='has_callback_request' AND udt_name='bool' AND is_nullable='YES' AND column_default IS NULL",
      );
      assert.equal(callback.rowCount, 1, 'Apply migration 048 to the isolated DB first');
      const reason = await client.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='unanswered_questions' AND column_name='reason' AND udt_name='text' AND is_nullable='YES' AND column_default IS NULL",
      );
      assert.equal(reason.rowCount, 1, 'Apply migration 049 to the isolated DB first');
      const dashboard = await client.query(
        "SELECT 1 WHERE to_regclass('public.call_dashboard_metrics') IS NOT NULL AND to_regprocedure('public.valid_call_latency_stats(jsonb)') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_persona_versions' AND column_name='previous_active_version_seq')",
      );
      assert.equal(dashboard.rowCount, 1, 'Apply migration 050 to the isolated DB first');
      const paymentRecovery = await client.query(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='order_payment_requests' AND column_name='approval_next_check_at' AND udt_name='timestamptz' AND is_nullable='YES') AND pg_get_indexdef(to_regclass('public.order_payment_reconcile_idx')) LIKE '%COALESCE(approval_next_check_at, approval_started_at)%'",
      );
      assert.equal(paymentRecovery.rowCount, 1, 'Apply migration 051 to the isolated DB first');
      const faqExamples = await client.query(
        "SELECT 1 WHERE to_regclass('public.faq_question_examples') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.faq_entries'::regclass AND tgname='faq_question_examples_reset' AND tgenabled='O')",
      );
      assert.equal(faqExamples.rowCount, 1, 'Apply migration 052 to the isolated DB first');
    } else {
      const directory = join(__dirname, '../../migrations');
      for (const file of readdirSync(directory)
        .filter((name) => /^\d{3}-.+\.sql$/.test(name))
        .sort())
        await client.query(readFileSync(join(directory, file), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
module.exports = { migrate };
