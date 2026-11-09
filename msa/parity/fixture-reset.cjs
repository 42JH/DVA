const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');

// Only test-data setup waits for workers; API requests and their assertions never retry here.
async function truncateFixture(pool, statement) {
  const identifier = '[a-z_][a-z0-9_]*(?:\\.[a-z_][a-z0-9_]*)?';
  const syntax = new RegExp('^TRUNCATE\\s+(' + identifier + '(?:\\s*,\\s*' + identifier +
    ')*)(?:\\s+RESTART\\s+IDENTITY)?(?:\\s+CASCADE)?;?$', 'i');
  const match = syntax.exec(statement);
  assert.ok(match, 'Expected a single fixture TRUNCATE statement');
  const client = await pool.connect();
  try {
    assert.equal((await client.query('SELECT current_database() AS name')).rows[0].name, 'dva_webhook_test');
    const names = (await client.query(`WITH RECURSIVE targets(oid) AS (
      SELECT unnest($1::text[])::regclass::oid
      UNION SELECT c.conrelid FROM pg_constraint c JOIN targets t ON c.confrelid=t.oid WHERE c.contype='f'
    ) SELECT format('%I.%I',n.nspname,c.relname) AS name FROM targets t
      JOIN pg_class c ON c.oid=t.oid JOIN pg_namespace n ON n.oid=c.relnamespace ORDER BY t.oid`,
    [match[1].split(',').map(name => name.trim())])).rows.map(row => row.name);
    assert.ok(names.length, 'Fixture tables must exist');
    const deadline = performance.now() + 5000;
    for (;;) {
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout='100ms'");
        // NOWAIT releases partial locks before a worker can form a circular wait.
        await client.query('LOCK TABLE ' + names.join(',') + ' IN ACCESS EXCLUSIVE MODE NOWAIT');
        await client.query(statement);
        await client.query('COMMIT');
        return;
      } catch (error) {
        await client.query('ROLLBACK');
        if (!['55P03', '40P01'].includes(error.code) || performance.now() >= deadline) throw error;
        await pause(25);
      }
    }
  } finally {
    client.release();
  }
}

module.exports = { truncateFixture };
