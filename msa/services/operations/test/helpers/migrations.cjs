const assert = require('node:assert/strict');

// The parity runner applies actual Liquibase changesets before starting this service.
async function migrate(pool) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
  assert.equal((await pool.query('SELECT count(*) FROM databasechangelog')).rows[0].count, '4');
  await pool.query('SELECT name,deleted_at FROM admin_users LIMIT 0');
  await pool.query('SELECT session_token_hash FROM admin_sessions LIMIT 0');
  await pool.query('SELECT actor_name,target_admin_name FROM audit_logs LIMIT 0');
}
module.exports = { migrate };
