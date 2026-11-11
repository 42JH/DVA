const customerAddress = require('./helpers/customer-address.cjs');
const { businessHeaders } = require('./helpers/application.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt, randomBytes } = require('node:crypto');
const { AuditService } = require('../dist/audit/audit.service');
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
const f = require('./helpers/faqs.cjs')();
const phone = () => '018' + randomInt(10000000, 99999999);
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()).data;
}
async function call(ended = true) {
  const providerCallId = randomUUID(),
    number = phone();
  const row = (
    await f.pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at)
    VALUES($1,$2,clock_timestamp(),CASE WHEN $3 THEN clock_timestamp() END,CASE WHEN $3 THEN clock_timestamp() END) RETURNING call_session_seq AS id,incoming_at`,
      [providerCallId, number, ended],
    )
  ).rows[0];
  return { ...row, providerCallId, phone: number };
}
async function order() {
  const key = randomUUID();
  const body = {
    customer: { name: '삭제 검증 고객', phoneNumber: phone() },
    parcels: [{ origin: { name: '보존 원본' }, destination: { name: '수령인' }, smallBoxCount: 1 }],
  };
  const result = await data(
    await f.write('POST', '/api/orders', body, 0, { 'Idempotency-Key': key }),
    201,
  );
  return { ...result, key, body };
}
const remove = (kind, id, actor = 0, headers = {}) =>
  f.write(
    'DELETE',
    `/api/${kind}`,
    { [{ calls: 'callSessionSeqs', orders: 'orderSeqs' }[kind]]: [id] },
    actor,
    headers,
  );
const ai = (path, body) =>
  fetch(f.base + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('new DELETE routes require an administrator session and an allowed Origin and document 204/404/409', async () => {
  const c = await call(),
    o = await order();
  for (const [kind, id] of [
    ['calls', c.id],
    ['orders', o.orderSeq],
  ]) {
    await f.error(await remove(kind, id, 0, { Cookie: undefined }), 401, 'UNAUTHORIZED');
    await f.error(await remove(kind, id, 0, { Origin: undefined }), 403, 'FORBIDDEN');
    await f.error(await remove(kind, id, 0, { Origin: 'https://other.invalid' }), 403, 'FORBIDDEN');
    await f.error(await remove(kind, 2147483647), 404, 'NOT_FOUND');
    await f.error(await remove(kind, '0'), 400, 'INVALID_REQUEST');
  }
});

test('order soft deletion preserves snapshots and retention dates while hiding reads and rejecting replay', async () => {
  const o = await order();
  const before = (
    await f.pool.query('SELECT created_at,closed_at FROM orders WHERE order_seq=$1', [o.orderSeq])
  ).rows[0];
  assert.equal((await remove('orders', o.orderSeq)).status, 204);
  await f.error(await f.get('/api/orders/' + o.orderSeq), 404, 'NOT_FOUND');
  await f.error(await remove('orders', o.orderSeq), 404, 'NOT_FOUND');
  await f.error(
    await f.write('POST', '/api/orders', o.body, 0, { 'Idempotency-Key': o.key }),
    409,
    'INVALID_STATE',
  );
  const row = (
    await f.pool.query('SELECT created_at,closed_at,deleted_at FROM orders WHERE order_seq=$1', [
      o.orderSeq,
    ])
  ).rows[0];
  assert.deepEqual({ created_at: row.created_at, closed_at: row.closed_at }, before);
  assert.ok(row.deleted_at);
  assert.equal(
    (await f.pool.query('SELECT origin_name FROM order_parcels WHERE order_seq=$1', [o.orderSeq]))
      .rows[0].origin_name,
    '보존 원본',
  );
  const listed = await (await f.get('/api/admin/orders?q=보존 원본&limit=100')).json();
  assert.ok(listed.data.every((row) => row.orderSeq !== o.orderSeq));
  assert.equal(
    (
      await f.pool.query('SELECT count(*)::int AS n FROM orders WHERE creation_request_id=$1', [
        o.key,
      ])
    ).rows[0].n,
    1,
  );
});

test('call soft deletion hides transcript, analysis, actions, questions and recording URLs while preserving raw rows', async (t) => {
  const c = await call();
  await f.pool.query(
    "INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES($1,1,'CUSTOMER','녹취와 함께 보존',1)",
    [c.id],
  );
  await f.pool.query('INSERT INTO recordings(call_session_seq,object_key) VALUES($1,$2)', [
    c.id,
    'recordings/' + randomUUID(),
  ]);
  await f.pool.query(
    "INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,complaints,payload_hash,has_callback_request) VALUES($1,clock_timestamp(),clock_timestamp(),'[]',repeat('a',64),true)",
    [c.id],
  );
  const question = await data(
    await ai('/api/ai/unanswered-questions', {
      eventId: randomUUID(),
      callSessionSeq: c.id,
      providerCallId: c.providerCallId,
      questionText: '보관할 질문',
      reason: 'KB_UNAVAILABLE',
      occurredAt: new Date().toISOString(),
      offsetSeconds: 0,
    }),
    201,
  );
  const { RecordingPlaybackService } = require('../dist/consultations/recording-playback.service');
  let urls = 0;
  t.mock.method(f.app.get(RecordingPlaybackService), 'create', async () => {
    urls++;
    return { playbackUrl: 'https://test.invalid/play', playbackError: null };
  });
  assert.equal((await remove('calls', c.id)).status, 204);
  for (const suffix of ['', '/transcript', '/actions', '/processing-results'])
    await f.error(await f.get(`/api/calls/${c.id}${suffix}`), 404, 'NOT_FOUND');
  assert.equal(urls, 0);
  const list = await (await f.get('/api/calls?callerPhoneNumber=' + c.phone)).json();
  assert.deepEqual(list.data, []);
  assert.equal(list.total_count, 0);
  const questions = await (await f.get('/api/unanswered-questions?callSessionSeq=' + c.id)).json();
  assert.equal(questions.total_count, 0);
  await f.error(await remove('calls', c.id), 404, 'NOT_FOUND');
  for (const table of ['call_utterances', 'recordings', 'call_analyses'])
    assert.equal(
      (await f.pool.query(`SELECT 1 FROM ${table} WHERE call_session_seq=$1`, [c.id])).rowCount,
      1,
    );
  assert.equal(
    (
      await f.pool.query(
        'SELECT has_callback_request FROM call_analyses WHERE call_session_seq=$1',
        [c.id],
      )
    ).rows[0].has_callback_request,
    true,
  );
  assert.deepEqual(
    (
      await f.pool.query(
        'SELECT question_text,reason FROM unanswered_questions WHERE unanswered_question_seq=$1',
        [question.unansweredQuestionSeq],
      )
    ).rows[0],
    { question_text: '보관할 질문', reason: 'KB_UNAVAILABLE' },
  );
  assert.deepEqual(
    (await f.pool.query('SELECT incoming_at FROM call_sessions WHERE call_session_seq=$1', [c.id]))
      .rows[0].incoming_at,
    c.incoming_at,
  );
});

test('deleted calls reject AI registration, STT/events, analysis, questions and order scope access', async () => {
  const { businessHeaders } = require('./helpers/application.cjs');
  const c = await call();
  assert.equal((await remove('calls', c.id)).status, 204);
  const context = await f.write(
    'POST',
    '/api/customers/context',
    {
      phoneNumber: c.phone,
      call: { providerCallId: c.providerCallId, incomingAt: c.incoming_at.toISOString() },
    },
    0,
    { Cookie: undefined, Origin: undefined, ...businessHeaders() },
  );
  await f.error(context, 409, 'INVALID_STATE');
  await f.error(
    await ai(`/api/ai/calls/${c.id}/events`, {
      providerCallId: c.providerCallId,
      events: [
        {
          eventId: randomUUID(),
          eventOrder: 1,
          kind: 'UTTERANCE',
          occurredAt: new Date().toISOString(),
          offsetSeconds: 0,
          payload: {
            utteranceOrder: 1,
            speaker: 'CUSTOMER',
            utteranceText: '늦은 재전송',
            lastSentenceSeq: 1,
          },
        },
      ],
    }),
    404,
    'NOT_FOUND',
  );
  await f.error(
    await ai(`/api/ai/calls/${c.id}/analysis`, {
      providerCallId: c.providerCallId,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      aiPersonaVersionSeq: null,
      repeatQuestionCount: 0,
      hasComplaint: false,
      complaints: [],
    }),
    404,
    'NOT_FOUND',
  );
  await f.error(
    await ai('/api/ai/unanswered-questions', {
      eventId: randomUUID(),
      callSessionSeq: c.id,
      providerCallId: c.providerCallId,
      questionText: '늦은 질문',
      occurredAt: new Date().toISOString(),
      offsetSeconds: 0,
    }),
    404,
    'NOT_FOUND',
  );
  await f.error(
    await f.get('/api/orders', 0, {
      Cookie: undefined,
      ...businessHeaders(),
      call_session_seq: String(c.id),
    }),
    404,
    'NOT_FOUND',
  );
});

test('pending recording receipts block call deletion until their upload is durably recorded', async () => {
  const c = await call();
  const recordingId = randomUUID(),
    claimId = randomUUID(),
    key = 'recordings/' + randomUUID();
  await f.pool.query(
    "INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq,received_at) VALUES($1,'{}',$2,clock_timestamp()-interval '2 minutes')",
    [recordingId, c.id],
  );
  for (const status of ['RECEIVED', 'FAILED']) {
    await f.pool.query(
      'UPDATE pbx_webhooks.call_ended_events SET processing_status=$2 WHERE recording_id=$1',
      [recordingId, status],
    );
    await f.error(await remove('calls', c.id), 409, 'INVALID_STATE');
    assert.equal((await f.get('/api/calls/' + c.id)).status, 200);
    assert.equal(
      (await f.pool.query('SELECT deleted_at FROM call_sessions WHERE call_session_seq=$1', [c.id]))
        .rows[0].deleted_at,
      null,
    );
  }
  await f.pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET claim_id=$2,claimed_until=clock_timestamp()+interval '5 minutes' WHERE recording_id=$1",
    [recordingId, claimId],
  );
  const { PbxWebhookRepository } = require('../dist/webhooks/pbx/pbx-webhook.repository');
  assert.equal(
    await f.app.get(PbxWebhookRepository).processed(recordingId, c.id, key, claimId),
    true,
  );
  assert.equal((await remove('calls', c.id)).status, 204);
  assert.equal(
    (await f.pool.query('SELECT object_key FROM recordings WHERE call_session_seq=$1', [c.id]))
      .rows[0].object_key,
    key,
  );
});

test('expired order references reject AI events atomically while a current customer order still works', async () => {
  const c = await call();
  const customer = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('참조 검증',$1,'ACTIVE') RETURNING customer_seq",
      [c.phone],
    )
  ).rows[0].customer_seq;
  const expired = (
    await f.pool.query(
      "INSERT INTO orders(customer_seq,status,created_at,closed_at) VALUES($1,'CANCELLED',clock_timestamp()-interval '6 years',clock_timestamp()-interval '6 years') RETURNING order_seq",
      [customer],
    )
  ).rows[0].order_seq;
  const current = (
    await f.pool.query(
      "INSERT INTO orders(customer_seq,status) VALUES($1,'COLLECTING') RETURNING order_seq",
      [customer],
    )
  ).rows[0].order_seq;
  await f.error(await f.get('/api/orders/' + expired), 404, 'NOT_FOUND');
  const event = (orderSeq, eventOrder = 1, eventId = randomUUID()) => ({
    eventId,
    eventOrder,
    kind: 'AI_ACTION',
    occurredAt: new Date().toISOString(),
    offsetSeconds: 0,
    payload: { action: 'PREVIOUS_ORDER_SEARCH', summaryText: '주문 참조 검사', orderSeq },
  });
  const send = (events) =>
    ai(`/api/ai/calls/${c.id}/events`, { providerCallId: c.providerCallId, events });
  await f.error(await send([event(expired)]), 404, 'NOT_FOUND');
  const ids = [randomUUID(), randomUUID()].sort();
  await f.error(
    await send([event(current, 1, ids[0]), event(expired, 2, ids[1])]),
    404,
    'NOT_FOUND',
  );
  assert.equal(
    (await f.pool.query('SELECT 1 FROM call_insight_events WHERE call_session_seq=$1', [c.id]))
      .rowCount,
    0,
  );
  assert.equal((await send([event(current)])).status, 204);
  assert.equal(
    (await f.pool.query('SELECT 1 FROM call_insight_events WHERE call_session_seq=$1', [c.id]))
      .rowCount,
    1,
  );
});

test('live calls, recording leases, payment and submission states cannot be deleted', async () => {
  const c = await call(false),
    o = await order();
  await f.error(await remove('calls', c.id), 409, 'INVALID_STATE');
  for (const status of [
    'notPaid',
    'PAID',
    'SUBMITTING',
    'SUBMITTING_FAILED',
    'SUBMISSION_FAILED',
  ]) {
    await f.pool.query(
      "UPDATE orders SET status=$2,payment_method_type='billing',pickup_requested_at=clock_timestamp() WHERE order_seq=$1",
      [o.orderSeq, status],
    );
    await f.error(await remove('orders', o.orderSeq), 409, 'INVALID_STATE');
  }
  const ended = await call();
  const id = randomUUID();
  await f.pool.query(
    `INSERT INTO pbx_webhooks.call_ended_events(recording_id,payload,call_session_seq,claim_id,claimed_until)
    VALUES($1,'{}',$2,gen_random_uuid(),clock_timestamp()+interval '5 minutes')`,
    [id, ended.id],
  );
  await f.error(await remove('calls', ended.id), 409, 'INVALID_STATE');
  await f.pool.query(
    "UPDATE pbx_webhooks.call_ended_events SET claim_id=NULL,claimed_until=NULL,processing_status='PROCESSED' WHERE recording_id=$1",
    [id],
  );
  assert.equal((await remove('calls', ended.id)).status, 204);
});

test('order/call deletion and successful audits roll back together on storage failure', async (t) => {
  const c = await call(),
    o = await order();
  const audit = f.app.get(AuditService),
    original = audit.recordSuccess.bind(audit);
  t.mock.method(audit, 'recordSuccess', (event, client) => {
    if (['CALL_DELETED', 'ORDER_DELETED'].includes(event.action)) throw Error('test-audit-failure');
    return original(event, client);
  });
  for (const [kind, id, table, key] of [
    ['calls', c.id, 'call_sessions', 'call_session_seq'],
    ['orders', o.orderSeq, 'orders', 'order_seq'],
  ]) {
    assert.equal((await remove(kind, id)).status, 500);
    assert.equal(
      (await f.pool.query(`SELECT deleted_at FROM ${table} WHERE ${key}=$1`, [id])).rows[0]
        .deleted_at,
      null,
    );
  }
});

test('order creator permissions survive audit TTL and do not transfer to another administrator', async () => {
  const o = await order();
  await f.pool.query("DELETE FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1", [
    o.orderSeq,
  ]);
  const replay = await data(
    await f.write('POST', '/api/orders', o.body, 0, { 'Idempotency-Key': o.key }),
    201,
  );
  assert.equal(replay.orderSeq, o.orderSeq);
  await f.error(
    await f.write('POST', '/api/orders', o.body, 1, { 'Idempotency-Key': o.key }),
    403,
    'FORBIDDEN',
  );
});

test('busy order/call row locks return a retriable conflict and never leave partial deletion', async () => {
  const c = await call(),
    o = await order();
  for (const [kind, id, table, key] of [
    ['calls', c.id, 'call_sessions', 'call_session_seq'],
    ['orders', o.orderSeq, 'orders', 'order_seq'],
  ]) {
    const client = await f.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM ${table} WHERE ${key}=$1 FOR UPDATE`, [id]);
      await f.error(await remove(kind, id), 409, 'REQUEST_IN_PROGRESS');
      assert.equal(
        (await client.query(`SELECT deleted_at FROM ${table} WHERE ${key}=$1`, [id])).rows[0]
          .deleted_at,
        null,
      );
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    assert.equal((await remove(kind, id)).status, 204);
  }
});

test('FAQ deletion retains content, hides AI results, sends DELETE and allows a new identity', async () => {
  const input = {
    category: '기타',
    question: '정규화 재등록 ' + randomUUID(),
    answer: '보관 답변',
  };
  const id = await f.createdId(input);
  assert.equal((await f.write('DELETE', '/api/faqs', { faqEntrySeqs: [id] })).status, 204);
  const row = (
    await f.pool.query(
      'SELECT question,answer,deleted_at FROM faq_entries WHERE faq_entry_seq=$1',
      [id],
    )
  ).rows[0];
  assert.equal(row.question, input.question);
  assert.equal(row.answer, input.answer);
  assert.ok(row.deleted_at);
  assert.deepEqual((await (await f.ai('?faqEntrySeqs=' + id)).json()).data, []);
  const next = await f.createdId({
    ...input,
    question: '  ' + input.question.toUpperCase() + '  ',
  });
  assert.notEqual(next, id);
  assert.equal(
    (
      await f.pool.query(
        "SELECT 1 FROM faq_change_notifications WHERE operation='DELETE' AND $1=ANY(faq_entry_seqs)",
        [id],
      )
    ).rowCount,
    1,
  );
});

test('company deletion preserves rows and historical identifiers while membership re-registration gets a new ID', async () => {
  const company = await data(
    await f.write('POST', '/api/companies', { name: '삭제 기업 ' + randomUUID() }),
    201,
  );
  const customer = await data(
    await f.write('POST', '/api/customers', {
      address: customerAddress(),
      name: '보존 고객',
      phoneNumber: phone(),
    }),
    201,
  );
  const co = company.organizationSeq,
    cu = customer.customerSeq;
  assert.equal(
    (
      await f.write('POST', `/api/companies/${co}/members`, {
        customerSeq: cu,
        employeeNo: 'EMP157',
        role: 'MEMBER',
      })
    ).status,
    204,
  );
  const old = (
    await f.pool.query(
      'SELECT membership_seq,employee_no FROM memberships WHERE customer_seq=$1 AND deleted_at IS NULL',
      [cu],
    )
  ).rows[0];
  assert.equal((await f.write('DELETE', '/api/companies', { organizationSeqs: [co] })).status, 204);
  for (const [table, key, id] of [
    ['organizations', 'organization_seq', co],
    ['memberships', 'membership_seq', old.membership_seq],
  ])
    assert.ok(
      (await f.pool.query(`SELECT deleted_at FROM ${table} WHERE ${key}=$1`, [id])).rows[0]
        .deleted_at,
    );
  assert.equal((await f.get('/api/customers/' + cu)).status, 200);
  await f.error(await f.get('/api/companies/' + co), 404, 'NOT_FOUND');
  const other = await data(
    await f.write('POST', '/api/companies', { name: '새 기업 ' + randomUUID() }),
    201,
  );
  assert.equal(
    (
      await f.write('POST', `/api/companies/${other.organizationSeq}/members`, {
        customerSeq: cu,
        employeeNo: 'EMP157',
        role: 'MEMBER',
      })
    ).status,
    204,
  );
  const links = (
    await f.pool.query(
      'SELECT membership_seq,deleted_at FROM memberships WHERE customer_seq=$1 ORDER BY membership_seq',
      [cu],
    )
  ).rows;
  assert.equal(links.length, 2);
  assert.ok(links[0].deleted_at);
  assert.equal(links[1].deleted_at, null);
  assert.notEqual(links[1].membership_seq, old.membership_seq);
});
require('./delete-array-contracts.cjs')(f);
