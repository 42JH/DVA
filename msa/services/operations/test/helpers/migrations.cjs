const assert = require('node:assert/strict');

// The parity runner applies actual Liquibase changesets before starting this service.
async function migrate(pool) {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
  assert.equal((await pool.query('SELECT count(*) FROM databasechangelog')).rows[0].count, '14');
  assert.equal((await pool.query("SELECT count(*) FROM databasechangelog WHERE id='010-order-audit' AND author='dva'")).rows[0].count, '1');
  assert.equal((await pool.query("SELECT count(*) FROM databasechangelog WHERE id='014-audit-action-result-index' AND author='dva'")).rows[0].count, '1');
  await pool.query('SELECT name,deleted_at FROM admin_users LIMIT 0');
  await pool.query('SELECT session_token_hash FROM admin_sessions LIMIT 0');
  await pool.query('SELECT actor_name,target_admin_name FROM audit_logs LIMIT 0');
  await pool.query('SELECT transaction_id,audit,aborted FROM customer_audit_preparations LIMIT 0');
  await pool.query('SELECT transaction_id,audit,aborted FROM order_audit_preparations LIMIT 0');
  await pool.query('SELECT prepared_event_id,ai_persona_version_seq,committed FROM consultation_persona_references LIMIT 0');
  await pool.query('SELECT role_text,personality_text,tone_text,speed_instruction,backchannel_text,interruption_text FROM ai_persona_versions LIMIT 0');
  for (const table of ['ai_personas', 'ai_persona_versions', 'ai_persona_drafts'])
    await pool.query('SELECT deleted_at FROM ' + table + ' LIMIT 0');
  for (const table of ['customers', 'orders', 'call_sessions'])
    assert.equal((await pool.query('SELECT to_regclass($1)::text AS name', [table])).rows[0].name, null);
}
module.exports = { migrate };
