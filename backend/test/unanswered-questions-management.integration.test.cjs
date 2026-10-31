require('reflect-metadata');
const { before, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { AuditService } = require('../dist/audit/audit.service');
const { DatabaseService } = require('../dist/database/database.service');
const { FaqsRepository } = require('../dist/faqs/faqs.repository');
const {
  UnansweredQuestionsRepository,
} = require('../dist/unanswered-questions/unanswered-questions.repository');
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
const f = require('./helpers/faqs.cjs')();
let secondBase;
before(async () => {
  secondBase = await (await f.start()).getUrl();
});
const body = () => ({
  category: '수거 일정',
  question: '관리자가 다듬은 질문 ' + f.marker(),
  answer: ' 답변 원문\n\n- 안내 ',
});
const write = (method, path, input, actor = 0, base = f.base, headers = {}) =>
  fetch(base + path, {
    method,
    headers: {
      Origin: f.origin,
      Cookie: f.cookies[actor],
      'Content-Type': 'application/json',
      ...headers,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
const convert = (id, input, actor = 0, base = f.base) =>
  write('POST', `/api/unanswered-questions/${id}/faqs`, input, actor, base);
const remove = (id, actor = 0, base = f.base) =>
  write('DELETE', `/api/unanswered-questions/${id}`, undefined, actor, base);
async function noContent(response) {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  return response.headers.get('location');
}
async function question() {
  const providerCallId = 'rtc_manage_' + randomUUID();
  const callId = (
    await f.pool.query(
      'INSERT INTO call_sessions(provider_call_id) VALUES($1) RETURNING call_session_seq',
      [providerCallId],
    )
  ).rows[0].call_session_seq;
  const input = {
    eventId: randomUUID(),
    callSessionSeq: callId,
    providerCallId,
    questionText: 'private-unanswered-original ' + f.marker(),
    occurredAt: '2026-10-31T10:00:20+09:00',
    offsetSeconds: 20,
  };
  const response = await collect(input);
  assert.equal(response.status, 201, await response.clone().text());
  return { id: (await response.json()).data.unansweredQuestionSeq, callId, providerCallId, input };
}
const collect = (input) =>
  fetch(f.base + '/api/ai/unanswered-questions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
const row = async (id) =>
  (await f.pool.query('SELECT * FROM unanswered_questions WHERE unanswered_question_seq=$1', [id]))
    .rows[0];
const successes = async (id, action) =>
  (
    await f.pool.query(
      "SELECT * FROM audit_logs WHERE target_type='UNANSWERED_QUESTION' AND target_seq=$1 AND action=$2 AND result='SUCCESS'",
      [id, action],
    )
  ).rows;
const notification = async (id) =>
  (
    await f.pool.query(
      'SELECT * FROM faq_change_notifications WHERE faq_entry_seqs @> ARRAY[$1]::int[]',
      [id],
    )
  ).rows;

test('management requires administrator session and allowed Origin; every active role can convert and delete', async () => {
  const q = await question();
  for (const [method, path, input] of [
    ['POST', `/api/unanswered-questions/${q.id}/faqs`, body()],
    ['DELETE', `/api/unanswered-questions/${q.id}`, undefined],
  ]) {
    await f.error(await write(method, path, input, 0, f.base, { Cookie: '' }), 401, 'UNAUTHORIZED');
    await f.error(await write(method, path, input, 0, f.base, { Origin: '' }), 403, 'FORBIDDEN');
    await f.error(
      await write(method, path, input, 0, f.base, { Origin: 'https://untrusted.invalid' }),
      403,
      'FORBIDDEN',
    );
    await f.error(
      await write(method, path, input, 0, f.base, { Cookie: '', Authorization: 'Bearer ' + token }),
      401,
      'UNAUTHORIZED',
    );
  }
  for (let actor = 0; actor < 3; actor++) {
    const register = await question(),
      deleted = await question();
    await noContent(await convert(register.id, body(), actor));
    await noContent(await remove(deleted.id, actor));
  }
  assert.equal((await row(q.id)).status, 'OPEN');
});

test('conversion requires all three fields and rejects invalid IDs, categories, blank text and added state', async () => {
  const q = await question(),
    input = body();
  for (const field of Object.keys(input)) {
    const missing = { ...input };
    delete missing[field];
    await f.error(await convert(q.id, missing), 400, 'INVALID_REQUEST');
  }
  for (const change of [
    { category: '전체' },
    { category: null },
    { question: '' },
    { question: null },
    { answer: ' \n' },
    { answer: 'x'.repeat(20001) },
    { status: 'REGISTERED' },
    { faqEntrySeq: 1 },
    { question: 'x\0' },
  ])
    await f.error(await convert(q.id, { ...input, ...change }), 400, 'INVALID_REQUEST');
  for (const id of ['0', '-1', '1.5', '2147483648']) {
    await f.error(await convert(id, input), 400, 'INVALID_REQUEST');
    await f.error(await remove(id), 400, 'INVALID_REQUEST');
  }
  await f.error(await convert(2147483647, input), 404, 'NOT_FOUND');
  await f.error(await remove(2147483647), 404, 'NOT_FOUND');
  await f.error(
    await convert(q.id, { ...input, answer: '가'.repeat(40000) }),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  assert.equal((await row(q.id)).status, 'OPEN');
});

test('conversion atomically stores the required FAQ category, original question history, admin audits and one existing AI notification', async () => {
  const q = await question(),
    input = body(),
    original = await row(q.id);
  const location = await noContent(await convert(q.id, input));
  assert.match(location, /^\/api\/faqs\/\d+$/);
  const faqId = Number(location.split('/').at(-1));
  const updated = await row(q.id);
  assert.equal(updated.status, 'REGISTERED');
  assert.equal(updated.faq_entry_seq, faqId);
  assert.match(updated.faq_conversion_hash, /^[a-f0-9]{64}$/);
  assert.ok(updated.registered_at);
  for (const key of [
    'question_text',
    'event_id',
    'payload_hash',
    'occurred_at',
    'offset_seconds',
    'created_at',
  ])
    assert.deepEqual(updated[key], original[key], key);
  const faq = (await (await f.get(location)).json()).data;
  for (const key of ['category', 'question', 'answer']) assert.equal(faq[key], input[key]);
  assert.equal(faq.updatedByAdminUserSeq, f.ids[0]);
  const notes = await notification(faqId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].operation, 'INSERT');
  assert.equal(notes[0].sent_at, null);
  const audits = await successes(q.id, 'UNANSWERED_QUESTION_REGISTERED');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_seq, f.ids[0]);
  assert.deepEqual(audits[0].metadata, {});
  assert.equal(notes[0].request_id, audits[0].request_id);
  const ai = (await (await f.ai('/' + faqId)).json()).data;
  assert.deepEqual(Object.keys(ai).sort(), ['answer', 'faqEntrySeq', 'question', 'updatedAt']);
  assert.equal(ai.question, input.question);
  assert.equal(
    (await (await f.get('/api/unanswered-questions?unansweredQuestionSeq=' + q.id)).json()).data
      .length,
    0,
  );
  const registered = (
    await (
      await f.get(
        '/api/unanswered-questions?' +
          new URLSearchParams({ unansweredQuestionSeq: q.id, status: 'REGISTERED' }),
      )
    ).json()
  ).data[0];
  assert.equal(registered.questionText, q.input.questionText);
  assert.equal(registered.faqEntrySeq, faqId);
  const replay = await collect(q.input);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.unansweredQuestionSeq, q.id);
  assert.deepEqual(await row(q.id), updated);
});

test('identical retries preserve the original conversion even after FAQ edits; changed conversion fields conflict', async () => {
  const q = await question(),
    input = body();
  const location = await noContent(await convert(q.id, input));
  const faqId = Number(location.split('/').at(-1));
  const edited = {
    category: '주소',
    question: '운영자가 다시 수정한 질문',
    answer: '운영자가 다시 수정한 답변',
  };
  await noContent(await f.patch(faqId, edited));
  const before = await f.counts(),
    state = await row(q.id);
  assert.equal(
    await noContent(
      await convert(
        q.id,
        { answer: input.answer, question: input.question, category: input.category },
        1,
      ),
    ),
    location,
  );
  assert.deepEqual(await f.counts(), before);
  assert.deepEqual(await row(q.id), state);
  const faq = (await (await f.get(location)).json()).data;
  for (const key of Object.keys(edited)) assert.equal(faq[key], edited[key]);
  for (const change of [
    { category: '접수' },
    { question: input.question + ' ' },
    { answer: input.answer + ' ' },
  ])
    await f.error(await convert(q.id, { ...input, ...change }), 409, 'INVALID_STATE');
  assert.deepEqual(await f.counts(), before);
});

test('two application instances create one FAQ for simultaneous retries and reject a different second conversion', async () => {
  const q = await question(),
    input = body();
  const before = await f.counts();
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) => convert(q.id, input, i % 3, i % 2 ? secondBase : f.base)),
  );
  const locations = await Promise.all(responses.map(noContent));
  assert.equal(new Set(locations).size, 1);
  const after = await f.counts();
  assert.equal(after.faqs, before.faqs + 1);
  assert.equal(after.notifications, before.notifications + 1);
  assert.equal(after.audits, before.audits + 1);
  assert.equal((await successes(q.id, 'UNANSWERED_QUESTION_REGISTERED')).length, 1);
  const another = await question();
  const results = await Promise.all([
    convert(another.id, body()),
    convert(another.id, body(), 1, secondBase),
  ]);
  assert.deepEqual(results.map((response) => response.status).sort(), [204, 409]);
});

test('FAQ, FAQ audit, notification, question update and question audit failures each roll back the full conversion', async () => {
  const audit = f.app.get(AuditService),
    database = f.app.get(DatabaseService);
  const faqs = f.app.get(FaqsRepository),
    questions = f.app.get(UnansweredQuestionsRepository);
  const cases = [
    () => {
      const original = faqs.insert;
      faqs.insert = async () => {
        throw Error('faq-insert-failure');
      };
      return () => {
        faqs.insert = original;
      };
    },
    () => {
      const original = audit.recordSuccess;
      audit.recordSuccess = function (event, client) {
        if (event.action === 'FAQ_CREATED') throw Error('faq-audit-failure');
        return original.call(this, event, client);
      };
      return () => {
        audit.recordSuccess = original;
      };
    },
    () => {
      const original = database.transaction;
      database.transaction = function (work) {
        return original.call(this, (client) =>
          work({
            query: (sql, ...args) => {
              if (String(sql).includes('INSERT INTO faq_change_notifications'))
                throw Error('queue-failure');
              return client.query(sql, ...args);
            },
          }),
        );
      };
      return () => {
        database.transaction = original;
      };
    },
    () => {
      const original = questions.register;
      questions.register = async () => {
        throw Error('question-update-failure');
      };
      return () => {
        questions.register = original;
      };
    },
    () => {
      const original = audit.recordSuccess;
      audit.recordSuccess = function (event, client) {
        if (event.action === 'UNANSWERED_QUESTION_REGISTERED')
          throw Error('question-audit-failure');
        return original.call(this, event, client);
      };
      return () => {
        audit.recordSuccess = original;
      };
    },
  ];
  for (const fail of cases) {
    const q = await question(),
      original = await row(q.id),
      before = await f.counts();
    const restore = fail();
    try {
      await f.error(await convert(q.id, body()), 500, 'INTERNAL_ERROR');
    } finally {
      restore();
    }
    assert.deepEqual(await row(q.id), original);
    assert.deepEqual(await f.counts(), before);
    assert.equal((await successes(q.id, 'UNANSWERED_QUESTION_REGISTERED')).length, 0);
  }
});

test('registered questions reject deletion and deleted linked FAQs are never recreated by conversion retry', async () => {
  const q = await question(),
    input = body();
  const location = await noContent(await convert(q.id, input));
  const faqId = Number(location.split('/').at(-1));
  await f.error(await remove(q.id), 409, 'INVALID_STATE');
  await noContent(await f.write('DELETE', '/api/faqs', { faqEntrySeqs: [faqId] }));
  const before = await f.counts(),
    original = await row(q.id);
  await f.error(await convert(q.id, input), 409, 'INVALID_STATE');
  assert.deepEqual(await f.counts(), before);
  assert.deepEqual(await row(q.id), original);
  assert.equal(original.status, 'REGISTERED');
  assert.equal(original.faq_entry_seq, faqId);
});

test('deletion clears only the work item text, hides linked result text and retains transcript and retry identity', async () => {
  const q = await question(),
    original = await row(q.id);
  const callBefore = (
    await f.pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [q.callId])
  ).rows;
  const events = [
    {
      kind: 'UTTERANCE',
      payload: {
        utteranceOrder: 1,
        speaker: 'CUSTOMER',
        utteranceText: q.input.questionText,
        lastSentenceSeq: 1,
      },
    },
    {
      kind: 'BUSINESS_RESULT',
      payload: {
        action: 'QUESTION_UNANSWERED',
        orderSeq: null,
        unansweredQuestionSeq: q.id,
        summaryText: '미답변 수집',
      },
    },
  ].map((event, index) => ({
    ...event,
    eventId: randomUUID(),
    eventOrder: index + 1,
    occurredAt: q.input.occurredAt,
    offsetSeconds: 20,
  }));
  const saved = await fetch(f.base + `/api/ai/calls/${q.callId}/events`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerCallId: q.providerCallId, events }),
  });
  assert.equal(saved.status, 204, await saved.text());
  assert.equal(await noContent(await remove(q.id)), null);
  const deleted = await row(q.id);
  assert.equal(deleted.status, 'DELETED');
  assert.equal(deleted.question_text, null);
  assert.ok(deleted.deleted_at);
  for (const key of ['event_id', 'payload_hash', 'created_at', 'occurred_at', 'offset_seconds'])
    assert.deepEqual(deleted[key], original[key]);
  await noContent(await remove(q.id, 1));
  assert.deepEqual(await row(q.id), deleted);
  assert.equal((await successes(q.id, 'UNANSWERED_QUESTION_DELETED')).length, 1);
  const replay = await collect(q.input);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.unansweredQuestionSeq, q.id);
  assert.deepEqual(await row(q.id), deleted);
  assert.equal(
    (await (await f.get(`/api/calls/${q.callId}/transcript`)).json()).data[0].utteranceText,
    q.input.questionText,
  );
  assert.equal(
    (await (await f.get(`/api/calls/${q.callId}/processing-results`)).json()).data[0].questionText,
    null,
  );
  assert.deepEqual(
    (await f.pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [q.callId])).rows,
    callBefore,
  );
  assert.deepEqual(
    await (await f.get('/api/unanswered-questions?unansweredQuestionSeq=' + q.id)).json(),
    { data: [], hasNext: false, total_count: 0 },
  );
  await f.error(await convert(q.id, body()), 409, 'INVALID_STATE');
});

test('deletion rejects body fields and rolls back text removal when its audit cannot persist', async () => {
  const q = await question(),
    original = await row(q.id);
  await f.error(
    await write('DELETE', '/api/unanswered-questions/' + q.id, { all: true }),
    400,
    'INVALID_REQUEST',
  );
  const audit = f.app.get(AuditService),
    record = audit.recordSuccess;
  audit.recordSuccess = function (event, client) {
    if (event.action === 'UNANSWERED_QUESTION_DELETED') throw Error('delete-audit-failure');
    return record.call(this, event, client);
  };
  try {
    await f.error(await remove(q.id), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = record;
  }
  assert.deepEqual(await row(q.id), original);
  await noContent(await remove(q.id));
});

test('concurrent deletes are idempotent and conversion versus deletion commits exactly one outcome', async () => {
  const q = await question();
  await Promise.all(
    (
      await Promise.all(
        Array.from({ length: 6 }, (_, i) => remove(q.id, i % 3, i % 2 ? secondBase : f.base)),
      )
    ).map(noContent),
  );
  assert.equal((await successes(q.id, 'UNANSWERED_QUESTION_DELETED')).length, 1);
  const another = await question(),
    before = await f.counts();
  const [registered, deleted] = await Promise.all([
    convert(another.id, body()),
    remove(another.id, 1, secondBase),
  ]);
  assert.deepEqual([registered.status, deleted.status].sort(), [204, 409]);
  const outcome = await row(another.id),
    after = await f.counts();
  if (outcome.status === 'REGISTERED') {
    assert.equal(registered.status, 204);
    assert.equal(outcome.question_text, another.input.questionText);
    assert.equal(after.faqs, before.faqs + 1);
  } else {
    assert.equal(outcome.status, 'DELETED');
    assert.equal(outcome.question_text, null);
    assert.equal(deleted.status, 204);
    assert.equal(after.faqs, before.faqs);
  }
});

test('OpenAPI documents management authentication, three required fields, 204 responses and bodyless deletion', async () => {
  const document = await (await f.get('/api/docs-json')).json();
  for (const [path, method] of [
    ['/api/unanswered-questions/{id}/faqs', 'post'],
    ['/api/unanswered-questions/{id}', 'delete'],
  ]) {
    const operation = document.paths[path][method];
    assert.deepEqual(operation.security, [{ adminSession: [] }]);
    for (const status of ['204', '400', '401', '403', '404', '409', '500'])
      assert.ok(operation.responses[status]);
  }
  assert.equal(document.paths['/api/unanswered-questions/{id}'].delete.requestBody, undefined);
  assert.deepEqual(document.components.schemas.CreateFaqDto.required.sort(), [
    'answer',
    'category',
    'question',
  ]);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-unanswered-original|rtc_manage_|Bearer /);
});

test('converting an unanswered question to an existing FAQ question is rejected atomically', async () => {
  const input = body();
  await f.createdId(input);
  const q = await question();
  const original = await row(q.id),
    before = await f.counts();
  await f.error(
    await convert(q.id, { ...input, category: '기타', answer: '다른 답변' }),
    409,
    'DUPLICATE_RESOURCE',
  );
  assert.deepEqual(await row(q.id), original);
  assert.deepEqual(await f.counts(), before);
  assert.equal((await successes(q.id, 'UNANSWERED_QUESTION_REGISTERED')).length, 0);
});
