const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const entries = require('../data/delivery-faq.json');
const f = require('./helpers/faqs.cjs')();
const migration = readFileSync(join(__dirname, '../migrations/027-faq-categories.sql'), 'utf8');

async function beforeMigration(run) {
  const client = await f.pool.connect();
  const schema = 'faq_category_test_' + randomUUID().replaceAll('-', '');
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(
      `CREATE TABLE ${schema}.faq_entries (LIKE public.faq_entries INCLUDING ALL)`,
    );
    await client.query(`ALTER TABLE ${schema}.faq_entries DROP COLUMN category`);
    await client.query(
      `CREATE TRIGGER faq_entry_timestamp BEFORE UPDATE ON ${schema}.faq_entries FOR EACH ROW EXECUTE FUNCTION public.touch_faq_entry()`,
    );
    await client.query(
      `CREATE TRIGGER faq_change_notification AFTER INSERT OR UPDATE OR DELETE ON ${schema}.faq_entries FOR EACH ROW EXECUTE FUNCTION public.notify_faq_change()`,
    );
    // 실제 migration에서 테이블의 격리 namespace만 바꾼다. SQL·조건·트리거 동작은 동일하다.
    const sql = migration.replaceAll('public.faq_entries', schema + '.faq_entries');
    await run(client, schema, sql);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

test('027 assigns all 32 reviewed categories while preserving every original field, trigger state and AI outbox', async () => {
  await beforeMigration(async (client, schema, sql) => {
    for (const [index, entry] of entries.entries())
      await client.query(
        `INSERT INTO ${schema}.faq_entries(question,answer,updated_by_admin_user_seq,created_at,updated_at)
        VALUES($1,$2,$3,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z')`,
        [entry.question, entry.answer, f.ids[index % 3]],
      );
    const snapshot = async () =>
      (
        await client.query(
          `SELECT to_jsonb(f)-'category' AS row FROM ${schema}.faq_entries f ORDER BY faq_entry_seq`,
        )
      ).rows;
    const before = await snapshot();
    const outbox = (await client.query('SELECT count(*) AS n FROM public.faq_change_notifications'))
      .rows;
    await client.query(sql);
    assert.deepEqual(await snapshot(), before);
    const rows = (
      await client.query(
        `SELECT category,question,answer FROM ${schema}.faq_entries ORDER BY faq_entry_seq`,
      )
    ).rows;
    assert.deepEqual(rows, entries);
    assert.deepEqual(
      (await client.query('SELECT count(*) AS n FROM public.faq_change_notifications')).rows,
      outbox,
    );
    const triggers = (
      await client.query(
        'SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal',
        [schema + '.faq_entries'],
      )
    ).rows;
    assert.equal(triggers.length, 2);
    assert.ok(triggers.every((row) => row.tgenabled === 'O'));
    await client.query(
      `UPDATE ${schema}.faq_entries SET answer='트리거 확인' WHERE faq_entry_seq=1`,
    );
    assert.ok(
      (
        await client.query(
          `SELECT updated_at>'2026-01-02T00:00:00Z' AS changed FROM ${schema}.faq_entries WHERE faq_entry_seq=1`,
        )
      ).rows[0].changed,
    );
  });
});

test('027 rejects unreviewed existing questions and rolls the entire schema and trigger changes back', async () => {
  await beforeMigration(async (client, schema, sql) => {
    await client.query(
      `INSERT INTO ${schema}.faq_entries(question,answer,updated_by_admin_user_seq) VALUES($1,$2,$3)`,
      [entries[0].question, entries[0].answer, f.ids[0]],
    );
    await client.query(
      `INSERT INTO ${schema}.faq_entries(question,answer,updated_by_admin_user_seq) VALUES('추가 검토가 필요한 새 질문','사용자 답변',$1)`,
      [f.ids[0]],
    );
    const snapshot = async () =>
      (await client.query(`SELECT * FROM ${schema}.faq_entries ORDER BY faq_entry_seq`)).rows;
    const before = await snapshot();
    await client.query('SAVEPOINT category_migration');
    await assert.rejects(() => client.query(sql), { code: '23514' });
    await client.query('ROLLBACK TO SAVEPOINT category_migration');
    assert.deepEqual(await snapshot(), before);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='faq_entries' AND column_name='category'",
          [schema],
        )
      ).rowCount,
      0,
    );
    assert.ok(
      (
        await client.query(
          'SELECT tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal',
          [schema + '.faq_entries'],
        )
      ).rows.every((row) => row.tgenabled === 'O'),
    );
  });
});

test('027 also supports an empty installation and enforces required category with no default or 전체 value', async () => {
  await beforeMigration(async (client, schema, sql) => {
    await client.query(sql);
    for (const [columns, values, code] of [
      ['question,answer,updated_by_admin_user_seq', "'질문','답변',1", '23502'],
      ['question,answer,updated_by_admin_user_seq,category', "'질문','답변',1,NULL", '23502'],
      ['question,answer,updated_by_admin_user_seq,category', "'질문','답변',1,'전체'", '23514'],
    ]) {
      await client.query('SAVEPOINT invalid_category');
      await assert.rejects(
        () => client.query(`INSERT INTO ${schema}.faq_entries(${columns}) VALUES(${values})`),
        { code },
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid_category');
    }
    await client.query(
      `INSERT INTO ${schema}.faq_entries(question,answer,updated_by_admin_user_seq,category) VALUES('질문','답변',$1,'접수')`,
      [f.ids[0]],
    );
    assert.equal(
      (await client.query(`SELECT category FROM ${schema}.faq_entries`)).rows[0].category,
      '접수',
    );
  });
});

test('administrator category storage and filtering leave AI list fields unchanged', async () => {
  const marker = f.marker();
  const ids = [];
  for (const category of ['접수', '주소', '접수'])
    ids.push(
      await f.createdId({ category, question: marker + ids.length, answer: '분류 검색 확인' }),
    );
  const response = await f.get(
    '/api/faqs?' + new URLSearchParams({ q: marker, category: '접수', limit: '1' }),
  );
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.deepEqual(
    first.data.map((row) => row.faqEntrySeq),
    [ids[0]],
  );
  assert.equal(first.data[0].category, '접수');
  assert.equal(first.hasNext, true);
  const last = await (
    await f.get(
      '/api/faqs?' + new URLSearchParams({ q: marker, category: '접수', limit: '1', offset: '1' }),
    )
  ).json();
  assert.deepEqual(
    last.data.map((row) => row.faqEntrySeq),
    [ids[2]],
  );
  assert.equal(last.hasNext, false);
  assert.equal((await (await f.get('/api/faqs/' + ids[1])).json()).data.category, '주소');
  for (const suffix of ['?category=전체', '?category=UNKNOWN', '?category=접수&category=주소'])
    await f.error(await f.get('/api/faqs' + suffix), 400, 'INVALID_REQUEST');
  await f.error(await f.ai('?category=접수'), 400, 'INVALID_REQUEST');
  for (const data of [
    ...(await (await f.ai('?faqEntrySeqs=' + ids[0])).json()).data,
    ...(await (await f.ai('?q=' + marker)).json()).data,
  ])
    assert.deepEqual(Object.keys(data).sort(), ['answer', 'faqEntrySeq', 'question', 'updatedAt']);
  const document = await (await f.get('/api/docs-json')).json();
  for (const name of ['CreateFaqDto', 'UpdateFaqDto'])
    assert.deepEqual(document.components.schemas[name].required.sort(), [
      'answer',
      'category',
      'question',
    ]);
  assert.equal(document.components.schemas.AgentFaqDto.properties.category, undefined);
  assert.ok(document.components.schemas.FaqDto.properties.category);
  assert.equal(
    document.paths['/api/ai/faqs'].get.parameters.some(
      (parameter) => parameter.name === 'category',
    ),
    false,
  );
});
