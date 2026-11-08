const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { restoreLegacyDraftBindings } = require('@dva/events/parcel-drafts.cjs');
assert.equal(process.env.PGDATABASE, 'dva_parcel_draft_test');
const pool = new Pool({ host: 'order-db', user: 'order_app' });
const database = { pool, transaction: async work => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT');
    if (process.env.CLAIM_PHASE === 'committed' && result === false) {
      process.send('committed'); await new Promise(() => {});
    }
    return result;
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
} };
restoreLegacyDraftBindings(database, process.env.BINDING_URL, process.env.CUSTOMER_AUTH_TOKEN)
  .then(() => pool.end()).catch(() => { process.exitCode = 1; return pool.end(); });
