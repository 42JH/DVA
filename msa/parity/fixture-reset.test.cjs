const { test } = require('node:test');
const assert = require('node:assert/strict');
const { truncateFixture } = require('./fixture-reset.cjs');

function fixture({ database = 'dva_webhook_test', lockError, truncateError } = {}) {
  const queries = [];
  let released = 0;
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.startsWith('SELECT current_database')) return { rows: [{ name: database }] };
      if (sql.startsWith('WITH RECURSIVE')) return { rows: [{ name: 'public.calls' }, { name: 'public.events' }] };
      if (sql.startsWith('LOCK TABLE') && lockError) { const error = lockError; lockError = null; throw error; }
      if (sql.startsWith('TRUNCATE') && truncateError) throw truncateError;
      return { rows: [] };
    },
    release() { released++; },
  };
  return { pool: { connect: async () => client }, queries, released: () => released };
}

test('fixture reset waits for a busy worker and preserves the exact reset statement', async () => {
  const f = fixture({ lockError: Object.assign(new Error('busy worker'), { code: '55P03' }) });
  const sql = 'TRUNCATE calls RESTART IDENTITY CASCADE';
  await truncateFixture(f.pool, sql);
  assert.equal(f.queries.filter(query => query === 'BEGIN').length, 2);
  assert.equal(f.queries.filter(query => query === sql).length, 1);
  assert.equal(f.queries.filter(query => query === 'ROLLBACK').length, 1);
  assert.equal(f.queries.at(-1), 'COMMIT');
  assert.equal(f.released(), 1);
});

test('fixture reset propagates other SQL errors and releases its client', async () => {
  const error = Object.assign(new Error('missing relation'), { code: '42P01' });
  const f = fixture({ truncateError: error });
  await assert.rejects(truncateFixture(f.pool, 'TRUNCATE calls'), error);
  assert.equal(f.queries.filter(query => query === 'BEGIN').length, 1);
  assert.equal(f.queries.at(-1), 'ROLLBACK');
  assert.equal(f.released(), 1);
});

test('fixture reset refuses a production database before acquiring write locks', async () => {
  const f = fixture({ database: 'production' });
  await assert.rejects(truncateFixture(f.pool, 'TRUNCATE calls'));
  assert.equal(f.queries.length, 1);
  assert.equal(f.released(), 1);
});

test('fixture reset rejects multiple statements before opening a connection', async () => {
  let connections = 0;
  await assert.rejects(truncateFixture({ connect: async () => connections++ }, 'TRUNCATE calls; SELECT 1'));
  assert.equal(connections, 0);
});
