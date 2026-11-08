const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');
const { DashboardRepository } = require('../dist/dashboard/dashboard.repository');
const {
  DROPOFF_STAGES,
  LATENCY_PROCESS_TYPES,
} = require('../dist/call-insights/call-dashboard-metrics.types');
const { DASHBOARD_COMPLAINT_TYPES } = require('../dist/dashboard/dto/dashboard-response.dto');
const pool = createTestPool();
const repository = new DashboardRepository({ pool });
const queries = [
  ['stageDropoffs', DROPOFF_STAGES.filter((stage) => stage !== 'NONE')],
  ['registrationTime'],
  ['complaintCalls', DASHBOARD_COMPLAINT_TYPES],
  ['responseWait', LATENCY_PROCESS_TYPES],
].map(([method, types]) => ({
  method,
  types,
  sql: readFileSync(join(__dirname, `fixtures/dashboard-${method}-a7988bf9.sql`), 'utf8'),
}));
let ids = [];
before(async () => {
  await migrate(pool);
  ids = (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
    SELECT $1::text||n,'2091-01-01'::timestamptz+n*interval '1 second',
     CASE WHEN n%3<>0 THEN '2091-01-01'::timestamptz+n*interval '1 second' END,
     CASE WHEN n%3<>0 THEN '2091-01-01'::timestamptz+n*interval '1 second'+interval '30 seconds' END
    FROM generate_series(1,3000) n RETURNING call_session_seq`,
      ['perf-dashboard-' + randomUUID()],
    )
  ).rows.map((r) => r.call_session_seq);
  await pool.query(
    `INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,is_new_customer,
     registered_parcel_count,has_complaint,complaints,payload_hash,ai_persona_version_seq)
    SELECT id,c.incoming_at,c.incoming_at+interval '30 seconds',
     CASE WHEN n%3=0 THEN NULL ELSE n%3=1 END,CASE WHEN n%7<>0 THEN n%4 END,
     CASE WHEN n%5<>0 THEN n%5=1 END,
     CASE WHEN n%5=1 THEN jsonb_build_array(jsonb_build_object('type',CASE WHEN n%2=0 THEN 'SLOW_RESPONSE' ELSE 'LEGACY' END,
       'evidenceText','performance fixture','offsetSeconds',1,'utteranceOrders','[]'::jsonb)) ELSE '[]'::jsonb END,
     repeat('a',64),(SELECT CASE WHEN n%2=0 THEN ai_persona_version_seq ELSE previous_active_version_seq END
       FROM ai_persona_versions WHERE status='ACTIVE')
    FROM unnest($1::int[]) WITH ORDINALITY t(id,n) JOIN call_sessions c ON c.call_session_seq=id WHERE n%11<>0`,
    [ids],
  );
  await pool.query(
    `INSERT INTO call_dashboard_metrics(call_session_seq,dropoff_stage,dropoff_payload_hash,dropoff_received_at,
     total_wait_ms,latency_stats,response_wait_payload_hash,response_wait_received_at)
    SELECT id,CASE WHEN n%3<>0 THEN CASE WHEN n%2=0 THEN 'NONE' ELSE 'SENDER_INFO' END END,
     CASE WHEN n%3<>0 THEN repeat('b',64) END,CASE WHEN n%3<>0 THEN now() END,
     CASE WHEN n%4<>0 THEN CASE WHEN n%5=0 THEN 40000 WHEN n%2=0 THEN 0 ELSE 50 END END,
     CASE WHEN n%4<>0 THEN CASE WHEN n%2=0 THEN '[]'::jsonb ELSE
      '[{"processType":"CUSTOMER_LOOKUP","measurementCount":1,"totalLatencyMs":50}]'::jsonb END END,
     CASE WHEN n%4<>0 THEN repeat('c',64) END,CASE WHEN n%4<>0 THEN now() END
    FROM unnest($1::int[]) WITH ORDINALITY t(id,n) JOIN call_analyses a ON a.call_session_seq=id
    WHERE n%3<>0 OR n%4<>0`,
    [ids],
  );
  await pool.query('UPDATE call_sessions SET deleted_at=now() WHERE call_session_seq=$1', [ids[0]]);
  await pool.query("UPDATE call_sessions SET incoming_at='2000-01-01' WHERE call_session_seq=$1", [
    ids[1],
  ]);
  for (const table of ['call_sessions', 'call_analyses', 'call_dashboard_metrics'])
    await pool.query('ANALYZE ' + table);
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
async function original(client, customerType) {
  const result = {};
  for (const { method, types, sql } of queries)
    result[method] = (
      await client.query(sql, types ? [customerType, types] : [customerType])
    ).rows[0].data;
  return result;
}
async function current(client, customerType) {
  return repository.performance(customerType, client);
}
test('dashboard metrics retain every original value for all customer types and individual routes', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const type of ['ALL', 'NEW', 'EXISTING']) {
      const expected = await original(client, type);
      assert.deepEqual(await current(client, type), expected, type);
      for (const { method } of queries)
        assert.deepEqual(
          await repository[method](type, client),
          expected[method],
          type + ' ' + method,
        );
    }
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
test('dashboard query work and alternating timings are recorded', async (t) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const statements = [];
    const capture = {
      query: async (sql, values) => {
        statements.push({ sql, values });
        return { rows: [{ data: {} }] };
      },
    };
    await current(capture, 'ALL');
    const plans = [[], []];
    const previous = queries.map(({ sql, types }) => ({
      sql,
      values: types ? ['ALL', types] : ['ALL'],
    }));
    for (const [i, group] of [previous, statements].entries())
      for (const { sql, values } of group)
        plans[i].push(
          (await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, values)).rows[0][
            'QUERY PLAN'
          ][0],
        );
    const scans = (plans) => {
      let count = 0;
      const visit = (node) => {
        if (node['Relation Name'] === 'call_sessions') count += node['Actual Loops'];
        for (const child of node.Plans ?? []) visit(child);
      };
      for (const plan of plans) visit(plan.Plan);
      return count;
    };
    const timings = [[], []];
    assert.equal(statements.length, 1);
    assert.equal(scans(plans[0]), 4);
    assert.equal(scans(plans[1]), 1);
    for (let round = 0; round < 10; round++)
      for (const i of round % 2 ? [1, 0] : [0, 1]) {
        const started = performance.now();
        await (i === 0 ? original(client, 'ALL') : current(client, 'ALL'));
        timings[i].push(performance.now() - started);
      }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    t.diagnostic(
      JSON.stringify({
        calls: ids.length,
        baseline: {
          queries: previous.length,
          callScans: scans(plans[0]),
          executionMs: plans[0].reduce((sum, p) => sum + p['Execution Time'], 0),
          medianMs: median(timings[0]),
        },
        current: {
          queries: statements.length,
          callScans: scans(plans[1]),
          executionMs: plans[1].reduce((sum, p) => sum + p['Execution Time'], 0),
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
