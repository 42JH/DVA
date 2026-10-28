const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { join } = require('node:path');
const entries = require('../data/delivery-faq.json');
const { seedFaqs } = require('../dist/faqs/faq-seed');
const f = require('./helpers/faqs.cjs')();
const execute = promisify(execFile);
const cli = (loginId) =>
  execute(process.execPath, [join(__dirname, '../dist/faqs/bootstrap-faq.js'), loginId], {
    env: process.env,
    timeout: 15000,
  });
// 실행 대상은 fixture가 검사한 임시 DB이며 FAQ 데이터만 초기화한다.
const clear = () => f.pool.query('DELETE FROM faq_entries');

test('21 seed: audit failure rolls back all rows and malformed data or missing/inactive actors cannot initialize', async () => {
  await clear();
  const before = await f.counts();
  await assert.rejects(() => seedFaqs(f.pool, f.loginIds[0], [{ question: '질문', answer: '' }]));
  await assert.rejects(() => seedFaqs(f.pool, 'NoSuchFaqAdmin', entries));
  await f.pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [f.ids[0]]);
  try {
    await assert.rejects(() => seedFaqs(f.pool, f.loginIds[0], entries));
  } finally {
    await f.pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
      f.ids[0],
    ]);
  }
  const connect = f.pool.connect;
  let auditCount = 0;
  f.pool.connect = async function () {
    const client = await connect.call(this);
    return {
      query: async (...args) => {
        if (String(args[0]).includes('INSERT INTO audit_logs') && ++auditCount === 2)
          throw Error('seed-audit-failure');
        return client.query(...args);
      },
      release: (...args) => client.release(...args),
    };
  };
  try {
    await assert.rejects(() => seedFaqs(f.pool, f.loginIds[0], entries), /seed-audit-failure/);
  } finally {
    f.pool.connect = connect;
  }
  assert.deepEqual(await f.counts(), before);
});

test('21 seed: CLI inserts 32 pairs in source order, records the chosen admin and preserves edits on rerun', async () => {
  await clear();
  const before = await f.counts();
  const result = await cli(f.loginIds[0]);
  assert.match(result.stdout, /32건/);
  const rows = (
    await f.pool.query(
      'SELECT faq_entry_seq,question,answer,updated_by_admin_user_seq FROM faq_entries ORDER BY faq_entry_seq',
    )
  ).rows;
  assert.deepEqual(
    rows.map(({ question, answer }) => ({ question, answer })),
    entries,
  );
  assert.ok(rows.every((r) => r.updated_by_admin_user_seq === f.ids[0]));
  assert.equal((await f.counts()).audits, before.audits + 32);
  const updated = await f.patch(rows[0].faq_entry_seq, { answer: '관리자가 수정한 답변' }, 1);
  assert.equal(updated.status, 204);
  const snapshot = (
    await f.pool.query(
      'SELECT jsonb_agg(to_jsonb(f) ORDER BY faq_entry_seq) AS data FROM faq_entries f',
    )
  ).rows[0].data;
  const count = await f.counts();
  const replay = await cli(f.loginIds[2]);
  assert.match(replay.stdout, /건너뛰/);
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT jsonb_agg(to_jsonb(f) ORDER BY faq_entry_seq) AS data FROM faq_entries f',
      )
    ).rows[0].data,
    snapshot,
  );
  assert.deepEqual(await f.counts(), count);
  assert.equal(
    (await (await f.ai('/' + rows[0].faq_entry_seq)).json()).data.answer,
    '관리자가 수정한 답변',
  );
});

test('21 seed: concurrent initializers create one batch and any existing FAQ prevents replacement or additions', async () => {
  await clear();
  const results = await Promise.all([
    seedFaqs(f.pool, f.loginIds[1], entries),
    seedFaqs(f.pool, f.loginIds[2], entries),
  ]);
  assert.deepEqual(
    results.map((r) => r.inserted).sort((a, b) => a - b),
    [0, 32],
  );
  assert.equal((await f.counts()).faqs, 32);
  await clear();
  const id = await f.createdId({ question: '운영 FAQ', answer: '보존' });
  assert.deepEqual(await seedFaqs(f.pool, f.loginIds[0], entries), { inserted: 0, skipped: true });
  assert.equal((await f.counts()).faqs, 1);
  assert.equal((await (await f.ai('/' + id)).json()).data.answer, '보존');
});

test('21 seed: an in-flight administrator insert wins without being overwritten by first-time loading', async () => {
  await clear();
  const client = await f.pool.connect();
  let pending;
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq) VALUES($1,$2,$3)',
      ['관리자 선행 등록', '유지', f.ids[0]],
    );
    pending = seedFaqs(f.pool, f.loginIds[1], entries);
    await client.query('COMMIT');
    assert.deepEqual(await pending, { inserted: 0, skipped: true });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  assert.equal((await f.counts()).faqs, 1);
});
