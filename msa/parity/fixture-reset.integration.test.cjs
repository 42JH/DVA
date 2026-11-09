const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { truncateFixture } = require('./fixture-reset.cjs');

test('fixture reset releases partial locks while a real worker owns a cascading child', async () => {
  const pool = new Pool();
  const worker = await pool.connect();
  let contended;
  const busy = new Promise(resolve => { contended = resolve; });
  let reset;
  try {
    assert.equal((await pool.query('SELECT current_database() AS name')).rows[0].name, 'dva_webhook_test');
    await pool.query(`CREATE TABLE fixture_reset_parent(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
      CREATE TABLE fixture_reset_child(id integer REFERENCES fixture_reset_parent);
      INSERT INTO fixture_reset_parent DEFAULT VALUES; INSERT INTO fixture_reset_child VALUES(1);`);
    await worker.query('BEGIN');
    await worker.query('LOCK TABLE fixture_reset_child IN ROW EXCLUSIVE MODE');
    const observed = { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (...args) => {
        try { return await client.query(...args); }
        catch (error) { if (error.code === '55P03') contended(); throw error; }
      } };
    } };
    reset = truncateFixture(observed, 'TRUNCATE fixture_reset_parent RESTART IDENTITY CASCADE');
    reset.catch(() => {});
    await Promise.race([busy, new Promise((_, reject) => setTimeout(() => reject(new Error('Expected real lock contention')), 2000).unref())]);
    await worker.query("SET LOCAL statement_timeout='2s'");
    await worker.query('SELECT * FROM fixture_reset_parent FOR SHARE');
    await worker.query('COMMIT');
    await reset;
    assert.equal((await pool.query('SELECT count(*) FROM fixture_reset_child')).rows[0].count, '0');
    assert.equal((await pool.query('INSERT INTO fixture_reset_parent DEFAULT VALUES RETURNING id')).rows[0].id, 1);
  } finally {
    await worker.query('ROLLBACK');
    worker.release();
    try {
      if (reset) await reset;
    } finally {
      try { await pool.query('DROP TABLE IF EXISTS fixture_reset_child,fixture_reset_parent CASCADE'); }
      finally { await pool.end(); }
    }
  }
});
