const assert=require('node:assert/strict');
async function migrate(pool){assert.equal((await pool.query("SELECT count(*)::int AS n FROM databasechangelog")).rows[0].n,3);await pool.query('SELECT registered_at,deleted_at FROM call_sessions LIMIT 0');await pool.query('SELECT claim_id,claimed_until FROM pbx_webhooks.call_ended_events LIMIT 0');}
module.exports={migrate};
