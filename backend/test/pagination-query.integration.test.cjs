const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createTestPool } = require('./helpers/application.cjs');
const { readPage } = require('../dist/common/pagination-query');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const pool = createTestPool();
let client;
before(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE pagination_count_cases(id int PRIMARY KEY,kind text,occurred_at timestamptz,payload jsonb);
    INSERT INTO pagination_count_cases SELECT i,CASE WHEN i<=5 THEN 'MATCH' ELSE 'OTHER' END,
    CASE WHEN i%2=0 THEN '2026-10-31T01:00:00Z'::timestamptz END,jsonb_build_object('index',i)
    FROM generate_series(1,8) AS i`);
});
after(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  await pool.end();
});
const select =
  'SELECT id,occurred_at AS "occurredAt",payload FROM pagination_count_cases WHERE kind=$1';
const order = '"occurredAt" DESC NULLS LAST,id DESC';
test('one filtered count covers every page while preserving original sort order, timestamp types and JSON values', async () => {
  const first = await readPage(client, select, ['MATCH'], { limit: 2, offset: 0 }, order);
  assert.equal(first.total_count, 5);
  assert.deepEqual(
    first.rows.map((row) => row.id),
    [4, 2, 5],
  );
  assert.ok(first.rows[0].occurredAt instanceof Date);
  assert.deepEqual(first.rows[0].payload, { index: 4 });
  assert.deepEqual(Object.keys(first.rows[0]).sort(), ['id', 'occurredAt', 'payload']);
  const last = await readPage(client, select, ['MATCH'], { limit: 2, offset: 4 }, order);
  assert.deepEqual(last, {
    rows: [{ id: 1, occurredAt: null, payload: { index: 1 } }],
    total_count: 5,
  });
});
test('past-end and maximum-safe offsets retain the full filtered count without returning the LEFT JOIN placeholder', async () => {
  for (const offset of [5, 100, Number.MAX_SAFE_INTEGER])
    assert.deepEqual(await readPage(client, select, ['MATCH'], { limit: 2, offset }, order), {
      rows: [],
      total_count: 5,
    });
});
test('no matching rows return an explicit zero while search values remain bound parameters', async () => {
  for (const value of ['MISSING', "MATCH' OR true --"])
    assert.deepEqual(await readPage(client, select, [value], { limit: 2, offset: 0 }, order), {
      rows: [],
      total_count: 0,
    });
  assert.equal(
    (await client.query('SELECT count(*)::int AS n FROM pagination_count_cases')).rows[0].n,
    8,
  );
});
test('array filters remain one bound parameter and count the selected row set', async () => {
  const page = await readPage(
    client,
    'SELECT id FROM pagination_count_cases WHERE kind=ANY($1::text[])',
    [['OTHER']],
    { limit: 1, offset: 1 },
    'id',
  );
  assert.deepEqual(page, { rows: [{ id: 7 }, { id: 8 }], total_count: 3 });
});
test('an empty source table produces an explicit zero with the same metadata contract', async () => {
  await client.query('CREATE TEMP TABLE pagination_empty_cases(id int)');
  assert.deepEqual(
    await readPage(
      client,
      'SELECT id FROM pagination_empty_cases',
      [],
      { limit: 20, offset: 5 },
      'id',
    ),
    { rows: [], total_count: 0 },
  );
});
test('missing, negative and unsafe count metadata is an error rather than an invented zero', async () => {
  for (const raw of [undefined, null, '-1', '9007199254740992', 'NaN'])
    await assert.rejects(
      () =>
        readPage(
          { query: async () => ({ rows: [{ __page_ordinal: null, __total_count: raw }] }) },
          'SELECT 1',
          [],
          { limit: 1, offset: 0 },
          '1',
        ),
      RangeError,
    );
  await assert.rejects(
    () =>
      readPage({ query: async () => ({ rows: [] }) }, 'SELECT 1', [], { limit: 1, offset: 0 }, '1'),
    RangeError,
  );
});
test('query failures propagate without a fallback count or hidden retry', async () => {
  const failure = new Error('database unavailable');
  let calls = 0;
  await assert.rejects(
    () =>
      readPage(
        {
          query: async () => {
            calls++;
            throw failure;
          },
        },
        'SELECT 1',
        [],
        { limit: 1, offset: 0 },
        '1',
      ),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});
