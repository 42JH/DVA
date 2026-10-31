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
        "SELECT 1 WHERE to_regclass('public.call_analyses') IS NOT NULL AND to_regclass('public.call_insight_events') IS NOT NULL AND to_regclass('public.unanswered_questions') IS NOT NULL AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='faq_entries' AND column_name='category' AND is_nullable='NO')",
      );
      assert.equal(events.rowCount, 1, 'Apply migrations through 028 to the isolated DB first');
      const customerMembership = await client.query(
        "SELECT 1 WHERE EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='customers' AND column_name='address_data' AND udt_name='jsonb') AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='memberships' AND column_name='department_seq' AND is_nullable='YES')",
      );
      assert.equal(customerMembership.rowCount, 1, 'Apply migration 028 to the isolated DB first');
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
