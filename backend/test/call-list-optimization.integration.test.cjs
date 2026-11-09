const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');
const { ConsultationsRepository } = require('../dist/consultations/consultations.repository');
const { CallQueryDto } = require('../dist/consultations/dto/call-query.dto');
const pool = createTestPool();
const repository = new ConsultationsRepository({ pool });
const baseline = readFileSync(join(__dirname, 'fixtures/call-list-a7988bf9.sql'), 'utf8');
let ids = [];
before(async () => {
  await migrate(pool);
  ids = (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at,analysis_failed_at)
   SELECT $1::text||n,'2093-01-01'::timestamptz+(n/2)*interval '1 second',
    CASE WHEN n%3<>0 THEN '2093-01-01'::timestamptz+(n/2)*interval '1 second' END,
    CASE WHEN n%3<>0 THEN '2093-01-01'::timestamptz+(n/2)*interval '1 second'+interval '30 seconds' END,
    CASE WHEN n%5=0 THEN now() END FROM generate_series(1,2000) n RETURNING call_session_seq`,
      ['perf-call-' + randomUUID()],
    )
  ).rows.map((r) => r.call_session_seq);
  await pool.query(
    `INSERT INTO recordings(call_session_seq,object_key,created_at)
   SELECT id,$2::text||id||'/'||n||'.wav','2093-01-01'::timestamptz+n*interval '1 second'
   FROM unnest($1::int[]) WITH ORDINALITY t(id,position) CROSS JOIN generate_series(1,6) n WHERE position%7<>0`,
    [ids, 'perf-recording/' + randomUUID() + '/'],
  );
  await pool.query(
    `INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,has_complaint,complaints,payload_hash,is_new_customer,registered_parcel_count)
   SELECT c.call_session_seq,c.incoming_at,c.incoming_at+interval '30 seconds',NULL,'[]',repeat('a',64),true,0
   FROM call_sessions c JOIN unnest($1::int[]) WITH ORDINALITY t(id,n) ON c.call_session_seq=t.id WHERE n%4=0`,
    [ids],
  );
  await pool.query('UPDATE call_sessions SET deleted_at=now() WHERE call_session_seq=$1', [ids[0]]);
  await pool.query("UPDATE call_sessions SET incoming_at='2000-01-01' WHERE call_session_seq=$1", [
    ids[1],
  ]);
  await pool.query('ANALYZE call_sessions');
  await pool.query('ANALYZE recordings');
  await pool.query('ANALYZE call_analyses');
});
after(async () => {
  try {
    await pool.query(
      'UPDATE call_sessions SET deleted_at=now() WHERE call_session_seq=ANY($1::int[])',
      [ids],
    );
  } finally {
    await pool.end();
  }
});
const query = (changes = {}) =>
  Object.assign(new CallQueryDto(), {
    from: '2093-01-01T00:00:00Z',
    to: '2093-01-02T00:00:00Z',
    ...changes,
  });
async function capture(input) {
  let statement;
  await new ConsultationsRepository({
    pool: {
      query: async (sql, values) => {
        statement = { sql, values };
        return { rows: [{ __total_count: '0', __page_ordinal: null }] };
      },
    },
  }).findMany(input);
  return statement;
}
test('call-page SQL retains every recordedAt, analysis field, sort and count from the original SQL', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const changes of [
      {},
      { offset: 950 },
      { offset: 1900 },
      { offset: 5000 },
      { offset: Number.MAX_SAFE_INTEGER },
      { limit: 1 },
      { limit: 100 },
    ]) {
      const input = query(changes);
      const current = await capture(input);
      assert.deepEqual(
        (await client.query(current.sql, current.values)).rows,
        (await client.query(baseline, current.values)).rows,
        JSON.stringify(changes),
      );
    }
    const detail = await repository.findOne(ids[19]);
    assert.equal(detail.analysisStatus, 'COMPLETED');
    assert.ok(detail.recordedAt instanceof Date);
    assert.ok(detail.analysis);
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
function loops(plan) {
  const result = [];
  const visit = (node) => {
    if (node['Node Type'] === 'Aggregate' && node['Parent Relationship'] === 'SubPlan')
      result.push(node['Actual Loops']);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return result;
}
test('call recordedAt work and alternating timings are measured without changing the payload', async (t) => {
  const client = await pool.connect();
  const input = query({ offset: 1900 });
  const current = await capture(input);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const plans = [];
    for (const sql of [baseline, current.sql])
      plans.push(
        (await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, current.values))
          .rows[0]['QUERY PLAN'][0],
      );
    assert.ok(loops(plans[0].Plan).some((n) => n > input.limit + 1));
    assert.ok(loops(plans[1].Plan).length > 0);
    assert.ok(loops(plans[1].Plan).every((n) => n <= input.limit + 1));
    const timings = [[], []];
    for (let round = 0; round < 10; round++)
      for (const i of round % 2 ? [1, 0] : [0, 1]) {
        const started = performance.now();
        await client.query(i === 0 ? baseline : current.sql, current.values);
        timings[i].push(performance.now() - started);
      }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    t.diagnostic(
      JSON.stringify({
        calls: ids.length,
        recordingsPerCall: 6,
        limit: input.limit,
        offset: input.offset,
        baseline: {
          recordedAtLoops: loops(plans[0].Plan),
          executionMs: plans[0]['Execution Time'],
          medianMs: median(timings[0]),
        },
        current: {
          recordedAtLoops: loops(plans[1].Plan),
          executionMs: plans[1]['Execution Time'],
          medianMs: median(timings[1]),
        },
      }),
    );
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
