require('reflect-metadata');
const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID } = require('node:crypto');
const { AuditService } = require('../dist/audit/audit.service');
const { RetentionRepository } = require('../dist/retention/retention.repository');
const { RetentionWorker } = require('../dist/retention/retention.worker');
process.env.AI_INSIGHTS_TOKEN = randomBytes(32).toString('hex');
const f = require('./helpers/faqs.cjs')();
let secondBase;
before(async () => {
  secondBase = await (await f.start()).getUrl();
});
const recent = () => new Date(Date.now() - 60_000).toISOString();
async function faq(age = '1 day') {
  return (
    await f.pool.query(
      `INSERT INTO faq_entries(question,answer,category,updated_by_admin_user_seq,created_at,updated_at)
       VALUES($1,'수거 일정 안내','수거 일정',$2,clock_timestamp()-$3::interval,clock_timestamp()-$3::interval)
       RETURNING faq_entry_seq`,
      [f.marker(), f.ids[0], age],
    )
  ).rows[0].faq_entry_seq;
}
async function call() {
  const providerCallId = randomUUID();
  const id = (
    await f.pool.query(
      `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
       VALUES($1,clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '10 minutes',clock_timestamp())
       RETURNING call_session_seq`,
      [providerCallId],
    )
  ).rows[0].call_session_seq;
  return { id, providerCallId };
}
const event = (eventOrder, kind, payload, occurredAt = recent()) => ({
  eventId: randomUUID(),
  eventOrder,
  kind,
  occurredAt,
  offsetSeconds: null,
  payload,
});
const result = (order, id, at = recent()) =>
  event(
    order,
    'BUSINESS_RESULT',
    {
      action: 'FAQ_ANSWERED',
      orderSeq: null,
      unansweredQuestionSeq: null,
      summaryText: 'FAQ 응대 완료',
      faqEntrySeqs: [id],
      questionUtteranceOrder: 1,
      answerUtteranceOrder: 2,
    },
    at,
  );
const batch = (ids, text = '수거 기사님은 몇 시까지 오세요?', at = recent()) => [
  event(
    1,
    'UTTERANCE',
    { utteranceOrder: 1, speaker: 'CUSTOMER', utteranceText: text, lastSentenceSeq: 1 },
    at,
  ),
  event(
    2,
    'UTTERANCE',
    {
      utteranceOrder: 2,
      speaker: 'AI',
      utteranceText: '실제 안내한 수거 일정',
      lastSentenceSeq: 1,
    },
    at,
  ),
  ...ids.map((id, index) => result(index + 3, id, at)),
];
const post = (c, events, base = f.base) =>
  fetch(`${base}/api/ai/calls/${c.id}/events`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.AI_INSIGHTS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ providerCallId: c.providerCallId, events }),
  });
async function success(response) {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), '');
}
async function detail(id, actor = 0) {
  const response = await f.get(`/api/faqs/${id}`, actor);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).data;
}
const examples = async (id) =>
  (
    await f.pool.query(
      'SELECT * FROM faq_question_examples WHERE faq_entry_seq=$1 ORDER BY occurred_at DESC,faq_question_example_seq DESC',
      [id],
    )
  ).rows;
const sourceCount = async (id) =>
  (
    await f.pool.query(
      'SELECT count(*)::int AS n FROM call_insight_events WHERE call_session_seq=$1',
      [id],
    )
  ).rows[0].n;

test('only administrator FAQ detail exposes raw customer examples; lists, source metadata, logs and Swagger remain separated', async () => {
  const id = await faq(),
    c = await call();
  assert.deepEqual((await detail(id)).recentQuestions, []);
  const before = await detail(id);
  const text = ' 민감-FAQ-사례-' + randomUUID() + ': <b>수거</b>는 언제 와요?\n';
  const values = batch([id], text);
  await success(await post(c, values));
  for (let actor = 0; actor < 3; actor++) {
    const data = await detail(id, actor);
    assert.equal(data.updatedAt, before.updatedAt);
    assert.equal(data.updatedByAdminUserSeq, before.updatedByAdminUserSeq);
    assert.equal(data.recentQuestions.length, 1);
    assert.deepEqual(Object.keys(data.recentQuestions[0]).sort(), [
      'callSessionSeq',
      'faqQuestionExampleSeq',
      'occurredAt',
      'questionText',
    ]);
    assert.equal(data.recentQuestions[0].callSessionSeq, c.id);
    assert.equal(data.recentQuestions[0].questionText, text);
    assert.equal(new Date(data.recentQuestions[0].occurredAt).toISOString(), values[2].occurredAt);
  }
  await f.error(await f.get(`/api/faqs/${id}`, 0, { Cookie: undefined }), 401, 'UNAUTHORIZED');
  for (const response of [
    await f.get('/api/faqs?' + new URLSearchParams({ q: before.question })),
    await f.ai('?faqEntrySeqs=' + id),
  ]) {
    assert.equal(response.status, 200);
    const data = (await response.json()).data.find((row) => row.faqEntrySeq === id);
    assert.ok(data, 'the filtered list must include the created FAQ');
    assert.equal(data.recentQuestions, undefined);
  }
  assert.equal(
    (
      await f.pool.query('SELECT 1 FROM faq_change_notifications WHERE $1=ANY(faq_entry_seqs)', [
        id,
      ])
    ).rowCount,
    0,
  );
  assert.doesNotMatch(JSON.stringify(f.logs), /민감-FAQ-사례/);
  assert.equal(
    (await f.pool.query("SELECT 1 FROM audit_logs WHERE metadata::text LIKE '%민감-FAQ-사례%'"))
      .rowCount,
    0,
  );
  const specResponse = await f.get('/api/docs-json');
  assert.equal(specResponse.status, 200);
  const spec = await specResponse.json();
  assert.equal(
    spec.components.schemas.FaqResponseDto.properties.data.$ref,
    '#/components/schemas/FaqDetailDto',
  );
  assert.equal(spec.components.schemas.FaqDetailDto.properties.recentQuestions.maxItems, 10);
  const exampleSchema = spec.components.schemas.FaqQuestionExampleDto;
  assert.equal(exampleSchema.properties.callSessionSeq.type, 'number');
  assert.equal(exampleSchema.properties.callSessionSeq.nullable, true);
  assert.equal(exampleSchema.properties.callSessionSeq.minimum, 1);
  assert.ok(exampleSchema.required.includes('callSessionSeq'));
  assert.equal(spec.components.schemas.FaqDto.properties.recentQuestions, undefined);
  assert.equal(spec.components.schemas.AgentFaqDto.properties.recentQuestions, undefined);
});

test('multiple FAQs can reference the same question/answer pair and repeated text remains separate for different events', async () => {
  const ids = [await faq(), await faq()],
    c = await call();
  const values = batch([ids[0]]);
  values[2].payload.faqEntrySeqs = ids.toReversed();
  await success(await post(c, values.toReversed()));
  for (const id of ids)
    assert.equal(
      (await detail(id)).recentQuestions[0].questionText,
      values[0].payload.utteranceText,
    );
  const processing = await f.get(`/api/calls/${c.id}/processing-results`);
  assert.equal(processing.status, 200);
  const body = await processing.json();
  assert.equal(body.total_count, 1);
  assert.equal(body.data[0].faqEntrySeq, null);
  assert.deepEqual(body.data[0].faqEntrySeqs, ids);
  const savedBeforeReplay = await examples(ids[0]);
  values[2].payload.faqEntrySeqs.reverse();
  await success(await post(c, values));
  assert.deepEqual(await examples(ids[0]), savedBeforeReplay);
  await success(await post(c, [result(5, ids[0], values[2].occurredAt)]));
  const other = await call();
  await success(await post(other, batch([ids[0]], values[0].payload.utteranceText)));
  const saved = (await detail(ids[0])).recentQuestions;
  assert.equal(saved.length, 3);
  assert.equal(new Set(saved.map((row) => row.faqQuestionExampleSeq)).size, 3);
  assert.equal(new Set(saved.map((row) => row.questionText)).size, 1);
  assert.equal(saved.filter((row) => row.callSessionSeq === c.id).length, 2);
  assert.equal(saved.filter((row) => row.callSessionSeq === other.id).length, 1);
  assert.equal(await sourceCount(c.id), 4);
});

test('an array preserves every historical FAQ ID while storing only eligible current FAQ examples', async () => {
  const valid = await faq(),
    edited = await faq(),
    deleted = await faq(),
    c = await call();
  const values = batch([valid]);
  values[2].payload.faqEntrySeqs = [2147483647, deleted, edited, valid];
  await success(
    await f.patch(edited, { category: '기타', question: f.marker(), answer: '응대 뒤 수정' }),
  );
  await success(await f.write('DELETE', '/api/faqs', { faqEntrySeqs: [deleted] }));
  await success(await post(c, values));
  assert.equal((await examples(valid)).length, 1);
  for (const id of [edited, deleted, 2147483647]) assert.deepEqual(await examples(id), []);
  assert.equal(await sourceCount(c.id), 3);
  const body = await (await f.get(`/api/calls/${c.id}/processing-results`)).json();
  assert.deepEqual(body.data[0].faqEntrySeqs, [valid, edited, deleted, 2147483647]);
});

test('the newest ten are retained by occurrence time; delayed old events and replay do not evict newer examples or erase source history', async () => {
  const id = await faq(),
    c = await call();
  const values = batch(Array(11).fill(id));
  for (let i = 2; i < values.length; i++)
    values[i].occurredAt = new Date(Date.now() - (200 - i) * 1000).toISOString();
  await success(await post(c, values.toReversed()));
  const saved = await examples(id);
  assert.equal(saved.length, 10);
  assert.equal(
    saved.some((row) => row.event_id === values[2].eventId),
    false,
  );
  assert.equal(saved[0].event_id, values.at(-1).eventId);
  assert.equal(await sourceCount(c.id), 13);
  await success(await post(c, [result(14, id, new Date(Date.now() - 3600_000).toISOString())]));
  assert.deepEqual(await examples(id), saved);
  await success(await post(c, values));
  assert.deepEqual(await examples(id), saved);
  assert.equal(await sourceCount(c.id), 14);
});

test('equal timestamps use stable example IDs, and concurrent apps keep exactly ten per FAQ with reversed FAQ input orders', async () => {
  const ids = [await faq(), await faq()];
  const calls = await Promise.all(Array.from({ length: 14 }, call));
  const at = recent();
  await Promise.all(
    calls.map(async (c, index) => {
      const values = batch([ids[0]], '동시에 들어온 같은 질문', at);
      values[2].payload.faqEntrySeqs = index % 2 ? ids.toReversed() : ids;
      await success(await post(c, values, index % 2 ? secondBase : f.base));
    }),
  );
  for (const id of ids) {
    const rows = await examples(id),
      displayed = (await detail(id)).recentQuestions;
    assert.equal(rows.length, 10);
    assert.deepEqual(
      displayed.map((row) => row.faqQuestionExampleSeq),
      rows.map((row) => row.faq_question_example_seq),
    );
    assert.ok(
      rows.every(
        (row, index) =>
          index === 0 || rows[index - 1].faq_question_example_seq > row.faq_question_example_seq,
      ),
    );
  }
  for (const c of calls) assert.equal(await sourceCount(c.id), 3);
});

test('FAQ edits clear all examples; old delayed events and identical replay cannot restore them, while newer answers can', async () => {
  const id = await faq(),
    c = await call(),
    values = batch([id, id]);
  await success(await post(c, values));
  await success(
    await f.patch(id, {
      category: '수거 일정',
      question: '수정한 수거 질문 ' + f.marker(),
      answer: '새 수거 안내',
    }),
  );
  assert.deepEqual((await detail(id)).recentQuestions, []);
  assert.deepEqual(await examples(id), []);
  await success(await post(c, values));
  await success(await post(c, [result(5, id, values[2].occurredAt)]));
  assert.deepEqual(await examples(id), []);
  assert.equal(await sourceCount(c.id), 5);
  const afterEdit = (
    await f.pool.query(
      "SELECT updated_at+interval '1 millisecond' AS at FROM faq_entries WHERE faq_entry_seq=$1",
      [id],
    )
  ).rows[0].at.toISOString();
  await success(await post(c, [result(6, id, afterEdit)]));
  assert.equal((await detail(id)).recentQuestions.length, 1);
});

test('saving identical FAQ fields preserves the existing modification cutoff and examples', async () => {
  const id = await faq(),
    c = await call();
  await success(await post(c, batch([id])));
  const original = await detail(id);
  await success(
    await f.patch(id, {
      category: original.category,
      question: original.question,
      answer: original.answer,
    }),
  );
  assert.deepEqual(await detail(id), original);
});

test('FAQ soft/physical deletion clears snapshots and still accepts delayed historical results without recreating examples', async () => {
  for (const physical of [false, true]) {
    const id = await faq(),
      c = await call(),
      values = batch([id]);
    await success(await post(c, values));
    if (physical) await f.pool.query('DELETE FROM faq_entries WHERE faq_entry_seq=$1', [id]);
    else await success(await f.write('DELETE', '/api/faqs', { faqEntrySeqs: [id] }));
    assert.deepEqual(await examples(id), []);
    await success(await post(c, [result(4, id)]));
    await success(await post(c, values));
    assert.deepEqual(await examples(id), []);
    assert.equal(await sourceCount(c.id), 4);
    await f.error(await f.get(`/api/faqs/${id}`), 404, 'NOT_FOUND');
  }
});

test('call soft deletion and the real call purge null the call link while preserving question text', async () => {
  const id = await faq(),
    c = await call(),
    values = batch([id]);
  await success(await post(c, values));
  const saved = (await detail(id)).recentQuestions;
  assert.equal(saved[0].callSessionSeq, c.id);
  const withoutCall = saved.map((row) => ({ ...row, callSessionSeq: null }));
  const snapshots = await examples(id);
  assert.equal((await f.get(`/api/calls/${c.id}`)).status, 200);
  await f.error(await f.get(`/api/calls/${c.id}`, 0, { Cookie: undefined }), 401, 'UNAUTHORIZED');
  await success(await f.write('DELETE', `/api/calls/${c.id}`, undefined, 2));
  await f.error(await f.get(`/api/calls/${c.id}`), 404, 'NOT_FOUND');
  assert.deepEqual((await detail(id)).recentQuestions, withoutCall);
  assert.deepEqual(await examples(id), snapshots);
  const claimId = randomUUID();
  await f.pool.query(
    "UPDATE call_sessions SET incoming_at=clock_timestamp()-interval '6 years',purge_claim_id=$2,purge_claimed_until=clock_timestamp()+interval '5 minutes' WHERE call_session_seq=$1",
    [c.id, claimId],
  );
  assert.equal(
    await f.app.get(RetentionRepository).finishCall({ id: c.id, claimId, phone: null, keys: [] }),
    true,
  );
  assert.equal(await sourceCount(c.id), 0);
  assert.equal(
    (await f.pool.query('SELECT 1 FROM call_utterances WHERE call_session_seq=$1', [c.id]))
      .rowCount,
    0,
  );
  assert.deepEqual((await detail(id)).recentQuestions, withoutCall);
  assert.deepEqual(await examples(id), snapshots);
});

test('call links follow detail visibility for legacy and expired calls without hiding recent examples', async () => {
  const id = await faq(),
    c = await call();
  await success(await post(c, batch([id])));
  const saved = (await detail(id)).recentQuestions;
  await f.pool.query('UPDATE call_sessions SET incoming_at=NULL WHERE call_session_seq=$1', [c.id]);
  assert.equal((await f.get(`/api/calls/${c.id}`)).status, 200);
  assert.deepEqual((await detail(id)).recentQuestions, saved);
  await f.pool.query(
    "UPDATE call_sessions SET incoming_at=clock_timestamp()-interval '6 years' WHERE call_session_seq=$1",
    [c.id],
  );
  await f.error(await f.get(`/api/calls/${c.id}`), 404, 'NOT_FOUND');
  assert.equal(await sourceCount(c.id), 3);
  assert.deepEqual(
    (await detail(id)).recentQuestions,
    saved.map((row) => ({ ...row, callSessionSeq: null })),
  );
});

test('five-year expiry is hidden immediately and physically removed by the existing retention worker without extending recent cases', async () => {
  const id = await faq('6 years'),
    c = await call();
  const expiredAt = (
    await f.pool.query("SELECT clock_timestamp()-interval '5 years' AS at")
  ).rows[0].at.toISOString();
  const expired = batch([id], '보존 기간이 지난 응대', expiredAt);
  await success(await post(c, expired));
  assert.equal(await sourceCount(c.id), 3);
  assert.deepEqual(await examples(id), []);
  await f.pool.query(
    `INSERT INTO faq_question_examples(faq_entry_seq,event_id,question_text,occurred_at)
    VALUES($1,$2,'만료 질문',clock_timestamp()-interval '5 years'),($1,$3,'아직 유효한 질문',clock_timestamp()-interval '4 years')`,
    [id, randomUUID(), randomUUID()],
  );
  const displayed = (await detail(id)).recentQuestions;
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].questionText, '아직 유효한 질문');
  assert.equal(displayed[0].callSessionSeq, null);
  assert.equal((await examples(id)).length, 2);
  await f.app.get(RetentionWorker).run();
  assert.equal((await examples(id)).length, 1);
  assert.deepEqual((await detail(id)).recentQuestions, displayed);
});

test('missing references roll back the complete batch; snapshot insertion and eviction also roll back on audit failure', async (t) => {
  const id = await faq(),
    c = await call();
  const invalid = batch([id]);
  invalid[2].payload.questionUtteranceOrder = 999;
  await f.error(await post(c, invalid), 404, 'NOT_FOUND');
  assert.equal(await sourceCount(c.id), 0);
  assert.deepEqual(await examples(id), []);
  await success(await post(c, batch(Array(10).fill(id))));
  const saved = await examples(id);
  const audit = t.mock.method(f.app.get(AuditService), 'recordSuccess', async () => {
    throw Error('private-example-audit-failure');
  });
  const next = result(13, id);
  try {
    await f.error(await post(c, [next]), 500, 'INTERNAL_ERROR');
    assert.deepEqual(await examples(id), saved);
    assert.equal(await sourceCount(c.id), 12);
  } finally {
    audit.mock.restore();
  }
  await success(await post(c, [next]));
  assert.equal((await examples(id)).length, 10);
  assert.equal((await examples(id))[0].event_id, next.eventId);
});

test('failed FAQ mutation preserves examples and bulk-delete failure rolls back every FAQ reset', async (t) => {
  const id = await faq(),
    c = await call();
  await success(await post(c, batch([id])));
  const original = await detail(id);
  const audit = t.mock.method(f.app.get(AuditService), 'recordSuccess', async () => {
    throw Error('private-faq-reset-failure');
  });
  try {
    await f.error(
      await f.patch(id, { category: '기타', question: f.marker(), answer: '실패할 수정' }),
      500,
      'INTERNAL_ERROR',
    );
    assert.deepEqual(await detail(id), original);
    await f.error(
      await f.write('DELETE', '/api/faqs', { faqEntrySeqs: [id] }),
      500,
      'INTERNAL_ERROR',
    );
    assert.deepEqual(await detail(id), original);
  } finally {
    audit.mock.restore();
  }
  await f.error(
    await f.write('DELETE', '/api/faqs', { faqEntrySeqs: [id, 2147483647] }),
    404,
    'NOT_FOUND',
  );
  assert.deepEqual(await detail(id), original);
});

test('concurrent FAQ edit and old delivery never leave pre-edit examples; bulk delete and reversed FAQ delivery do not deadlock', async () => {
  const id = await faq(),
    c = await call();
  await Promise.all([
    post(c, batch([id])).then(success),
    f
      .patch(id, { category: '기타', question: f.marker(), answer: '수정과 응대 경합' })
      .then(success),
  ]);
  assert.deepEqual(await examples(id), []);
  const ids = [await faq(), await faq()],
    other = await call();
  const values = batch([ids[0]]);
  values[2].payload.faqEntrySeqs = ids.toReversed();
  await Promise.all([
    post(other, values, secondBase).then(success),
    f.write('DELETE', '/api/faqs', { faqEntrySeqs: ids }).then(success),
  ]);
  for (const faqId of ids) assert.deepEqual(await examples(faqId), []);
  assert.equal(await sourceCount(other.id), 3);
});

test('the existing event boundary rejects extra questionText and conflicting retries without changing snapshots', async () => {
  const id = await faq(),
    c = await call(),
    values = batch([id]);
  await success(await post(c, values));
  const saved = await examples(id);
  const changed = structuredClone(values[2]);
  changed.payload.summaryText = '이미 저장한 이벤트의 다른 내용';
  await f.error(await post(c, [changed]), 409, 'EVENT_PAYLOAD_CONFLICT');
  const extra = result(4, id);
  extra.payload.questionText = '별도 질문 원문은 받지 않음';
  await f.error(await post(c, [extra]), 400, 'INVALID_REQUEST');
  assert.deepEqual(await examples(id), saved);
});
