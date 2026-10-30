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
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_logs' AND column_name='actor_name' AND to_regclass('public.order_billing_charges') IS NOT NULL",
      );
      assert.equal(latest.rowCount, 1, 'Use an empty isolated DB or apply all migrations first');
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
