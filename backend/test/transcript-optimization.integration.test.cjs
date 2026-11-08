const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');
const { ConsultationsRepository } = require('../dist/consultations/consultations.repository');
const pool = createTestPool();
const repository = new ConsultationsRepository({ pool });
let ids = [];
before(async () => {
  await migrate(pool);
  ids = (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
    SELECT $1::text||n,CASE WHEN n<>3 THEN now() END,now(),now()+interval '30 seconds'
    FROM generate_series(1,5) n RETURNING call_session_seq`,
      ['perf-transcript-' + randomUUID()],
    )
  ).rows.map((r) => r.call_session_seq);
  const complaints = Array.from({ length: 20 }, () => ({
    type: 'SLOW_RESPONSE',
    evidenceText: '근거'.repeat(1000),
    offsetSeconds: 1,
    utteranceOrders: [],
  }));
  await pool.query(
    `INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,has_complaint,complaints,payload_hash)
    VALUES($1,now(),now()+interval '30 seconds',true,$2,repeat('a',64))`,
    [ids[0], JSON.stringify(complaints)],
  );
  await pool.query(
    `INSERT INTO recordings(call_session_seq,object_key) SELECT $1,$2::text||n FROM generate_series(1,200) n`,
    [ids[0], 'perf-transcript-recording-' + randomUUID()],
  );
  await pool.query('UPDATE call_sessions SET deleted_at=now() WHERE call_session_seq=$1', [ids[1]]);
  await pool.query(
    "UPDATE call_sessions SET incoming_at=now()-interval '5 years 1 day' WHERE call_session_seq=$1",
    [ids[3]],
  );
  await pool.query(
    "UPDATE call_sessions SET incoming_at=now()-interval '5 years'+interval '1 day' WHERE call_session_seq=$1",
    [ids[4]],
  );
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
const exists = (repo, id) => repo.callExists(id);
test('transcript call visibility retains detail rules for deleted, expired, legacy and missing calls', async () => {
  for (const [i, id] of [...ids, 2147483647].entries()) {
    const expected = !!(await repository.findOne(id));
    assert.equal(await exists(repository, id), expected);
    assert.equal(expected, [true, false, true, false, true, false][i]);
  }
});
test('transcript call checks measure table work and DB payload without returning the full analysis', async (t) => {
  const statements = [];
  const capture = new ConsultationsRepository({
    pool: {
      query: async (sql, values) => {
        statements.push({ sql, values });
        return { rows: [], rowCount: 0 };
      },
    },
  });
  await capture.findOne(ids[0]);
  await exists(capture, ids[0]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const plans = [],
      sizes = [];
    for (const { sql, values } of statements) {
      plans.push(
        (await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, values)).rows[0][
          'QUERY PLAN'
        ][0],
      );
      sizes.push(Buffer.byteLength(JSON.stringify((await client.query(sql, values)).rows)));
    }
    const relations = (plan) => {
      const names = new Set();
      const visit = (node) => {
        if (node['Relation Name']) names.add(node['Relation Name']);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan);
      return [...names].sort();
    };
    const timings = [[], []];
    assert.deepEqual(relations(plans[1].Plan), ['call_sessions']);
    assert.ok(sizes[0] > 100000);
    assert.ok(sizes[1] < 100);
    for (let round = 0; round < 10; round++)
      for (const i of round % 2 ? [1, 0] : [0, 1]) {
        const started = performance.now();
        await client.query(statements[i].sql, statements[i].values);
        timings[i].push(performance.now() - started);
      }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    t.diagnostic(
      JSON.stringify({
        baseline: {
          tables: relations(plans[0].Plan),
          jsonBytes: sizes[0],
          executionMs: plans[0]['Execution Time'],
          medianMs: median(timings[0]),
        },
        current: {
          tables: relations(plans[1].Plan),
          jsonBytes: sizes[1],
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
