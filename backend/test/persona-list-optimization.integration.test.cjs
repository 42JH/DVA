const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');
const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
const pool = createTestPool();
const baseline = readFileSync(join(__dirname, 'fixtures/persona-list-a7988bf9.sql'), 'utf8');
let ids = [];
before(async () => {
  await migrate(pool);
  ids = (
    await pool.query(
      `INSERT INTO ai_personas(code) SELECT $1::text||n FROM generate_series(1,420) n RETURNING ai_persona_seq`,
      ['perf-persona-' + randomUUID()],
    )
  ).rows.map((r) => r.ai_persona_seq);
  await pool.query(
    `INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,voice_id,speaking_rate,turn_wait_level)
    SELECT id,v,'성능 페르소나 '||n,repeat(' 원문 보존 \n',1000)||v,
     CASE WHEN n%2=0 THEN 'voice' END,CASE WHEN n%3=0 THEN 1.1 END,'NORMAL'
    FROM unnest($1::int[]) WITH ORDINALITY t(id,n) CROSS JOIN generate_series(1,3) v WHERE n<=400`,
    [ids],
  );
  await pool.query(
    `INSERT INTO ai_persona_drafts(ai_persona_seq,draft_revision,base_version,name,prompt_text,turn_wait_level,updated_by_admin_user_seq)
    SELECT id,$2,3,'초안 '||n,repeat('초안 원문\n',1000),'LONG',1 FROM unnest($1::int[]) WITH ORDINALITY t(id,n) WHERE n<=400 AND n%2=0`,
    [ids, randomUUID()],
  );
  for (const table of ['ai_personas', 'ai_persona_versions', 'ai_persona_drafts'])
    await pool.query('ANALYZE ' + table);
});
after(async () => {
  try {
    await pool.query('DELETE FROM ai_persona_drafts WHERE ai_persona_seq=ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM ai_persona_versions WHERE ai_persona_seq=ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM ai_personas WHERE ai_persona_seq=ANY($1::int[])', [ids]);
  } finally {
    await pool.end();
  }
});
async function previous(client, input, id) {
  const result = await client.query(baseline, [id ?? null, input.limit + 1, input.offset]);
  return {
    total_count: Number(result.rows[0].__total_count),
    rows: result.rows
      .filter((r) => r.__page_ordinal !== null)
      .map(({ __total_count, __page_ordinal, ...row }) => row),
  };
}
test('persona pages and details retain all original version, prompt, draft, metadata and null values', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const repository = new AiSettingsRepository({ pool: client });
    for (const [input, id] of [
      [{ limit: 20, offset: 0 }],
      [{ limit: 20, offset: 150 }],
      [{ limit: 20, offset: 350 }],
      [{ limit: 20, offset: 5000 }],
      [{ limit: 20, offset: Number.MAX_SAFE_INTEGER }],
      [{ limit: 1, offset: 0 }],
      [{ limit: 100, offset: 0 }],
      [{ limit: 1, offset: 0 }, ids[0]],
      [{ limit: 1, offset: 0 }, ids[400]],
      [{ limit: 1, offset: 0 }, 2147483647],
    ])
      assert.deepEqual(
        await repository.personas(input, id),
        await previous(client, input, id),
        JSON.stringify({ input, id }),
      );
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
test('persona page query work and alternating timings are recorded', async (t) => {
  let statement;
  const input = { limit: 20, offset: 350 };
  await new AiSettingsRepository({
    pool: {
      query: async (sql, values) => {
        statement = { sql, values };
        return { rows: [{ __total_count: '0', __page_ordinal: null }] };
      },
    },
  }).personas(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const plans = [];
    for (const sql of [baseline, statement.sql])
      plans.push(
        (await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, statement.values))
          .rows[0]['QUERY PLAN'][0],
      );
    const limits = (plan) => {
      const ns = [];
      const visit = (node) => {
        if (node['Node Type'] === 'Limit') ns.push(node['Actual Loops']);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan);
      return ns;
    };
    const timings = [[], []];
    assert.ok(limits(plans[0].Plan).some((n) => n > input.limit + 1));
    assert.ok(limits(plans[1].Plan).length > 0);
    assert.ok(limits(plans[1].Plan).every((n) => n <= input.limit + 1));
    const repository = new AiSettingsRepository({ pool: client });
    for (let round = 0; round < 10; round++)
      for (const i of round % 2 ? [1, 0] : [0, 1]) {
        const started = performance.now();
        await (i === 0 ? previous(client, input) : repository.personas(input));
        timings[i].push(performance.now() - started);
      }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    t.diagnostic(
      JSON.stringify({
        personas: 400,
        versionsPerPersona: 3,
        limit: input.limit,
        offset: input.offset,
        baseline: {
          limitLoops: limits(plans[0].Plan),
          executionMs: plans[0]['Execution Time'],
          medianMs: median(timings[0]),
        },
        current: {
          limitLoops: limits(plans[1].Plan),
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
