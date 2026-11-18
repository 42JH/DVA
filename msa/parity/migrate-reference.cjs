const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
const { Pool } = require('pg');

(async () => {
  const pool = new Pool();
  const client = await pool.connect();
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'dva_webhook_test');
    await client.query('BEGIN');
    assert.equal((await client.query("SELECT to_regclass('public.admin_users') AS name")).rows[0].name, null);
    for (const file of readdirSync('./migrations').filter(name => /^\d{3}-.+\.sql$/.test(name)).sort())
      await client.query(readFileSync('./migrations/' + file, 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
