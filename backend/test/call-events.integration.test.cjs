require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, randomInt, createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createTestPool, startTestApp } = require('./helpers/application.cjs');
const { ConfigService } = require('@nestjs/config');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.SWAGGER_ENABLED = 'true';
const pool = createTestPool();
const logs = [];
const apps = [];
let base, secondBase, config, audit, cookie;
const event = (eventOrder = 1, changes = {}) => ({
  eventId: randomUUID(),
  eventOrder,
  kind: 'AI_ACTION',
  occurredAt: '2026-10-31T10:00:31+09:00',
  offsetSeconds: 31,
  payload: {
    action: 'FIELD_SAVED',
    summaryText: '민감-이벤트-본문: 입력 내용 저장',
    orderSeq: null,
  },
  ...changes,
});
const utterance = (order, utteranceOrder = order, changes = {}) =>
  event(order, {
    kind: 'UTTERANCE',
    payload: {
      utteranceOrder,
      speaker: 'CUSTOMER',
      utteranceText: ' 민감-이벤트-본문: 발화 원문\n',
      lastSentenceSeq: 1,
    },
    ...changes,
  });
const business = (order, changes = {}) =>
  event(order, {
    kind: 'BUSINESS_RESULT',
    payload: {
      action: 'INQUIRY',
      orderSeq: null,
      unansweredQuestionSeq: null,
      summaryText: '문의 기록',
    },
    ...changes,
  });
async function createCall(orderSeq = null, phone = '01012345678', client = pool) {
  const providerCallId = 'rtc_events_' + randomUUID();
  const id = (
    await client.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,order_seq,started_at,ended_at)
     VALUES($1,$2,$3,'2026-10-31T01:00:00Z','2026-10-31T01:03:00Z') RETURNING call_session_seq`,
      [providerCallId, phone, orderSeq],
    )
  ).rows[0].call_session_seq;
  return { id, providerCallId };
}
async function createCustomerOrder() {
  const phone = '010' + String(randomInt(100000000)).padStart(8, '0');
  const customerId = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('이벤트 테스트',$1,'ACTIVE') RETURNING customer_seq",
      [phone],
    )
  ).rows[0].customer_seq;
  const orderId = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [
      customerId,
    ])
  ).rows[0].order_seq;
  return { phone, customerId, orderId };
}
async function createQuestion(callId, deleted = false) {
  return (
    await pool.query(
      `INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,payload_hash,status,deleted_at)
     VALUES($1,$2,$3,'2026-10-31T01:00:31Z',$4,$5,$6) RETURNING unanswered_question_seq`,
      [
        randomUUID(),
        callId,
        deleted ? null : '테스트 미답변',
        'a'.repeat(64),
        deleted ? 'DELETED' : 'OPEN',
        deleted ? new Date() : null,
      ],
    )
  ).rows[0].unanswered_question_seq;
}
function post(call, events, options = {}) {
  return fetch(`${options.base || base}/api/ai/calls/${options.id ?? call.id}/events`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify({ providerCallId: options.providerCallId ?? call.providerCallId, events }),
  });
}
async function success(response) {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const value = await response.json();
  assert.equal(value.error.code, code);
  assert.ok(value.meta.requestId);
  assert.doesNotMatch(JSON.stringify(value), /민감-이벤트-본문|rtc_events_|INSERT INTO|SELECT /);
}
async function rows(callId) {
  return (
    await pool.query(
      'SELECT * FROM call_insight_events WHERE call_session_seq=$1 ORDER BY event_order',
      [callId],
    )
  ).rows;
}
async function audits(callId) {
  return (
    await pool.query(
      "SELECT * FROM audit_logs WHERE action='CALL_EVENTS_RECORDED' AND target_seq=$1 AND result='SUCCESS'",
      [callId],
    )
  ).rows;
}
before(async () => {
  await migrate(pool);
  assert.ok(
    (await pool.query("SELECT to_regclass('public.call_insight_events') AS name")).rows[0].name,
    'Apply 025 and 026 to the isolated DB first',
  );
  const { AuditService } = require('../dist/audit/audit.service');
  for (let i = 0; i < 2; i++) {
    await startTestApp(apps, { log: (value) => logs.push(value) });
  }
  base = await apps[0].getUrl();
  secondBase = await apps[1].getUrl();
  config = apps[0].get(ConfigService);
  audit = apps[0].get(AuditService);
  const adminId = (
    await pool.query(
      `INSERT INTO admin_users(login_id,name,password_hash,role,status)
     VALUES($1,'이벤트 관리자','test-only','SYSTEM_ADMIN','ACTIVE') RETURNING admin_user_seq`,
      ['evt' + randomUUID().replaceAll('-', '').slice(0, 16)],
    )
  ).rows[0].admin_user_seq;
  const session = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)', [
    createHash('sha256').update(session).digest('hex'),
    adminId,
  ]);
  cookie = 'dva_session=' + session;
});
after(async () => {
  for (const app of apps.reverse()) await app.close();
  await pool.end();
});

test('EVT-01 requires its service token, rejects an admin-cookie substitute and fails closed when disabled', async () => {
  const c = await createCall();
  for (const headers of [
    { Authorization: '' },
    { Authorization: 'Bearer wrong' },
    { Authorization: '', Cookie: cookie, Origin: process.env.CORS_ORIGINS },
  ])
    await error(await post(c, [event()], { headers }), 401, 'UNAUTHORIZED');
  config.set('AI_INSIGHTS_TOKEN', '');
  try {
    await error(await post(c, [event()]), 503, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    config.set('AI_INSIGHTS_TOKEN', token);
  }
  await error(await post(c, [event()], { providerCallId: 'other-call' }), 403, 'FORBIDDEN');
  await error(await post(c, [event()], { id: 2147483647 }), 404, 'NOT_FOUND');
  await error(await post(c, [event()], { id: 'abc' }), 400, 'INVALID_REQUEST');
  assert.deepEqual(await rows(c.id), []);
});

test('three out-of-order requests persist 120 events; 50 is a request limit, not a call limit', async () => {
  const c = await createCall();
  const values = Array.from({ length: 120 }, (_, index) => event(index + 1));
  for (const batch of [values.slice(50, 100), values.slice(0, 50), values.slice(100)])
    await success(await post(c, batch.reverse()));
  const stored = await rows(c.id);
  assert.equal(stored.length, 120);
  assert.deepEqual(
    stored.map((row) => row.event_order),
    Array.from({ length: 120 }, (_, i) => i + 1),
  );
  assert.ok(
    stored.every((row) => row.offset_seconds === '31' && !Object.hasOwn(row.payload, 'status')),
  );
  assert.equal((await audits(c.id)).length, 3);
  await error(
    await post(
      c,
      Array.from({ length: 51 }, (_, i) => event(i + 121)),
    ),
    400,
    'INVALID_REQUEST',
  );
  assert.equal((await rows(c.id)).length, 120);
});

test('completed utterances appear in the existing transcript and preserve call, order and evidence', async () => {
  const owner = await createCustomerOrder();
  const c = await createCall(owner.orderId, owner.phone);
  const before = (await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [c.id]))
    .rows[0];
  const values = [
    utterance(3, 2, { offsetSeconds: 31 }),
    event(2),
    utterance(1, 1, { offsetSeconds: 0 }),
    business(4, {
      payload: {
        action: 'ORDER_CREATED',
        orderSeq: owner.orderId,
        unansweredQuestionSeq: null,
        summaryText: '기존 주문 생성 기록',
      },
    }),
  ];
  await success(await post(c, values));
  const response = await fetch(`${base}/api/calls/${c.id}/transcript`, {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  const transcript = await response.json();
  assert.deepEqual(
    transcript.data.map((row) => row.utteranceOrder),
    [1, 2],
  );
  assert.ok(transcript.data.every((row) => row.utteranceText === values[0].payload.utteranceText));
  const stored = await rows(c.id);
  assert.equal(stored.filter((row) => row.kind === 'UTTERANCE').length, 2);
  assert.ok(
    stored
      .filter((row) => row.kind === 'UTTERANCE')
      .every((row) => row.payload === null && row.call_utterance_seq),
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [c.id])).rows[0],
    before,
  );
  const auditRows = await audits(c.id);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].actor_type, 'AI');
  assert.deepEqual(auditRows[0].metadata, {});
  assert.doesNotMatch(JSON.stringify(logs), /민감-이벤트-본문|rtc_events_|Bearer /);
});

test('concurrent equivalent replays across instances preserve one batch, transcript and success audit', async () => {
  const c = await createCall();
  const values = [utterance(1), event(2)];
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      post(c, values, { base: i % 2 ? secondBase : base }).then(success),
    ),
  );
  const first = await rows(c.id);
  const equivalent = values.toReversed().map((value) => ({
    ...Object.fromEntries(Object.entries(value).reverse()),
    eventId: value.eventId.toUpperCase(),
    occurredAt: '2026-10-31T01:00:31.000Z',
    payload: Object.fromEntries(Object.entries(value.payload).reverse()),
  }));
  await success(await post(c, equivalent));
  assert.deepEqual(await rows(c.id), first);
  assert.equal(
    (await pool.query('SELECT 1 FROM call_utterances WHERE call_session_seq=$1', [c.id])).rowCount,
    1,
  );
  assert.equal((await audits(c.id)).length, 1);
});

test('changed IDs, orders or payloads conflict and an entire mixed batch rolls back', async () => {
  const c = await createCall();
  const original = event(1);
  await success(await post(c, [original]));
  for (const changed of [
    { ...original, eventOrder: 2 },
    { ...original, eventId: randomUUID() },
    { ...original, offsetSeconds: 32 },
  ])
    await error(await post(c, [changed]), 409, 'EVENT_PAYLOAD_CONFLICT');
  const fresh = utterance(3);
  await error(
    await post(c, [fresh, { ...original, offsetSeconds: 32 }]),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  assert.equal((await rows(c.id)).length, 1);
  assert.equal(
    (await pool.query('SELECT 1 FROM call_utterances WHERE call_session_seq=$1', [c.id])).rowCount,
    0,
  );
  const other = await createCall();
  await error(await post(other, [original]), 409, 'EVENT_PAYLOAD_CONFLICT');
  assert.deepEqual(await rows(other.id), []);
});

test('different final utterances cannot overwrite one sequence, including a legacy transcript row', async () => {
  const c = await createCall();
  const original = utterance(1);
  await pool.query(
    'INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq) VALUES($1,1,$2,$3,1)',
    [c.id, original.payload.speaker, original.payload.utteranceText],
  );
  await success(await post(c, [original]));
  await error(await post(c, [utterance(2, 1)]), 409, 'EVENT_PAYLOAD_CONFLICT');
  await error(
    await post(c, [
      utterance(2, 1, { payload: { ...original.payload, utteranceText: '변경된 원문' } }),
    ]),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  assert.equal(
    (
      await pool.query('SELECT utterance_text FROM call_utterances WHERE call_session_seq=$1', [
        c.id,
      ])
    ).rows[0].utterance_text,
    original.payload.utteranceText,
  );
});

test('order references use the bound customer or caller identity and never another customer', async () => {
  const owner = await createCustomerOrder();
  const foreign = await createCustomerOrder();
  const c = await createCall(owner.orderId, owner.phone);
  const historicalOrder = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [
      owner.customerId,
    ])
  ).rows[0].order_seq;
  const value = (orderSeq, order) =>
    event(order, { payload: { action: 'ORDER_LOOKUP', summaryText: '기존 주문 확인', orderSeq } });
  await success(await post(c, [value(historicalOrder, 1)]));
  await error(await post(c, [value(foreign.orderId, 2)]), 403, 'FORBIDDEN');
  await error(await post(c, [value(2147483647, 2)]), 404, 'NOT_FOUND');
  const unbound = await createCall(null, owner.phone);
  await success(await post(unbound, [value(owner.orderId, 1)]));
  const unknown = await createCall(null, null);
  await error(await post(unknown, [value(owner.orderId, 1)]), 403, 'FORBIDDEN');
});

test('question references must exist in the same call and deleted questions are not revived', async () => {
  const c = await createCall();
  const other = await createCall();
  const questionId = await createQuestion(c.id, true);
  const otherId = await createQuestion(other.id);
  const value = (id) =>
    business(1, {
      payload: {
        action: 'QUESTION_UNANSWERED',
        orderSeq: null,
        unansweredQuestionSeq: id,
        summaryText: '미답변 발생 이력',
      },
    });
  await error(await post(c, [value(2147483647)]), 404, 'NOT_FOUND');
  await error(await post(c, [value(otherId)]), 403, 'FORBIDDEN');
  await success(await post(c, [value(questionId)]));
  assert.deepEqual(
    (
      await pool.query(
        'SELECT status,question_text FROM unanswered_questions WHERE unanswered_question_seq=$1',
        [questionId],
      )
    ).rows[0],
    { status: 'DELETED', question_text: null },
  );
});

test('seconds preserve zero and unknown; forbidden status, milliseconds, duplicates and oversized input never write', async () => {
  const c = await createCall();
  await success(await post(c, [event(1, { offsetSeconds: 0 }), event(2, { offsetSeconds: null })]));
  assert.deepEqual(
    (await rows(c.id)).map((row) => row.offset_seconds),
    ['0', null],
  );
  const value = event(3);
  for (const values of [
    [value, { ...value, eventOrder: 4 }],
    [value, event(3)],
    [event(3, { offsetMs: 31000 })],
    [event(3, { offsetSeconds: 31.1 })],
    [event(3, { payload: { ...value.payload, status: 'SUCCEEDED' } })],
  ])
    await error(await post(c, values), 400, 'INVALID_REQUEST');
  await error(
    await post(
      c,
      Array.from({ length: 6 }, (_, i) =>
        utterance(i + 3, i + 1, {
          payload: {
            utteranceOrder: i + 1,
            speaker: 'AI',
            utteranceText: 'x'.repeat(20000),
            lastSentenceSeq: 1,
          },
        }),
      ),
    ),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  assert.equal((await rows(c.id)).length, 2);
});

test('conflicting concurrent reports across instances choose one winner and audit failure rolls back all writes', async () => {
  const c = await createCall();
  const original = event();
  const responses = await Promise.all([
    post(c, [original]),
    post(c, [{ ...original, offsetSeconds: 32 }], { base: secondBase }),
  ]);
  assert.deepEqual(responses.map((value) => value.status).sort(), [204, 409]);
  assert.equal((await audits(c.id)).length, 1);
  const other = await createCall();
  const saved = audit.recordSuccess;
  audit.recordSuccess = async () => {
    throw new Error('simulated-events-audit-failure');
  };
  try {
    await error(await post(other, [utterance(1), event(2)]), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = saved;
  }
  assert.deepEqual(await rows(other.id), []);
  assert.equal(
    (await pool.query('SELECT 1 FROM call_utterances WHERE call_session_seq=$1', [other.id]))
      .rowCount,
    0,
  );
  await success(await post(other, [utterance(1), event(2)]));
});

require('./call-events-migrations.cjs')({
  test,
  pool,
  randomUUID,
  createCall,
  createHash,
  readFileSync,
  join,
  assert,
  success,
  get base() {
    return base;
  },
  set base(value) {
    base = value;
  },
  token,
  error,
});

test('database rejects cross-call question links, action status and invalid second offsets', async () => {
  const c = await createCall();
  const other = await createCall();
  const questionId = await createQuestion(other.id);
  const statement = `INSERT INTO call_insight_events(event_id,call_session_seq,event_order,kind,
    occurred_at,offset_seconds,unanswered_question_seq,payload,payload_hash)
    VALUES($1,$2,1,$3,'2026-10-31T01:00:31Z',$4,$5,$6::jsonb,$7)`;
  const values = [
    randomUUID(),
    c.id,
    'AI_ACTION',
    31,
    null,
    JSON.stringify({ action: 'FIELD_SAVED', summaryText: '저장', orderSeq: null }),
    'a'.repeat(64),
  ];
  const cases = [
    [
      [
        ...values.slice(0, 5),
        JSON.stringify({ action: 'FIELD_SAVED', status: 'SUCCEEDED' }),
        values[6],
      ],
      '23514',
    ],
    [[...values.slice(0, 3), -1, ...values.slice(4)], '23514'],
    [
      [
        values[0],
        c.id,
        'BUSINESS_RESULT',
        31,
        questionId,
        JSON.stringify({
          action: 'QUESTION_UNANSWERED',
          orderSeq: null,
          unansweredQuestionSeq: questionId,
          summaryText: '질문',
        }),
        values[6],
      ],
      '23503',
    ],
  ];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [input, code] of cases) {
      await client.query('SAVEPOINT invalid_event');
      await assert.rejects(() => client.query(statement, input), { code });
      await client.query('ROLLBACK TO SAVEPOINT invalid_event');
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

const readEvents = (call, path, query = '', headers = { Cookie: cookie }) =>
  fetch(`${base}/api/calls/${call.id}/${path}?${query}`, { headers });

async function readBody(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  return body;
}

async function readSession(role) {
  const id = (
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'조회 관리자','test-only',$2,'ACTIVE') RETURNING admin_user_seq",
      ['view' + randomUUID().replaceAll('-', '').slice(0, 15), role],
    )
  ).rows[0].admin_user_seq;
  const value = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)', [
    createHash('sha256').update(value).digest('hex'),
    id,
  ]);
  return { id, headers: { Cookie: 'dva_session=' + value } };
}

async function createFaq() {
  return (
    await pool.query(
      `INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,category)
       VALUES($1,'현재 FAQ 답변',(SELECT admin_user_seq FROM admin_users LIMIT 1),'기타') RETURNING faq_entry_seq`,
      ['현재 FAQ 질문 ' + randomUUID()],
    )
  ).rows[0].faq_entry_seq;
}

const faqResult = (order, faqId, changes = {}) =>
  business(order, {
    payload: {
      action: 'FAQ_ANSWERED',
      orderSeq: null,
      unansweredQuestionSeq: null,
      summaryText: 'FAQ 안내 완료',
      faqEntrySeq: faqId,
      questionUtteranceOrder: 1,
      answerUtteranceOrder: 2,
      ...changes,
    },
  });

test('separate reads require active admin sessions; AI service tokens cannot read call records', async () => {
  const c = await createCall();
  for (const path of ['actions', 'processing-results', 'transcript']) {
    for (const headers of [
      {},
      { Authorization: 'Bearer ' + token },
      { call_session_seq: String(c.id) },
      { Cookie: 'dva_session=' + '0'.repeat(64) },
    ]) {
      await error(await readEvents(c, path, '', headers), 401, 'UNAUTHORIZED');
      await error(await readEvents({ id: 2147483647 }, path, '', headers), 401, 'UNAUTHORIZED');
    }
    for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
      const account = await readSession(role);
      assert.deepEqual(await readBody(await readEvents(c, path, '', account.headers)), {
        data: [],
        hasNext: false,
        total_count: 0,
      });
    }
    await error(await readEvents({ id: 2147483647 }, path), 404, 'NOT_FOUND');
  }
  for (const inactive of ['PENDING', 'INACTIVE']) {
    const account = await readSession('OPERATOR');
    await pool.query('UPDATE admin_users SET status=$2 WHERE admin_user_seq=$1', [
      account.id,
      inactive,
    ]);
    for (const path of ['actions', 'processing-results'])
      await error(await readEvents(c, path, '', account.headers), 401, 'UNAUTHORIZED');
  }
  const expired = await readSession('OPERATOR');
  await pool.query(
    "UPDATE admin_sessions SET expires_at=clock_timestamp()-interval '1 second',created_at=clock_timestamp()-interval '10 hours' WHERE admin_user_seq=$1",
    [expired.id],
  );
  for (const path of ['actions', 'processing-results'])
    await error(await readEvents(c, path, '', expired.headers), 401, 'UNAUTHORIZED');
});

test('separate read contracts reject kind filters, malformed pagination and unsupported fields', async () => {
  const c = await createCall();
  for (const path of ['actions', 'processing-results']) {
    for (const id of ['0', '-1', '1.5', '2147483648', 'abc'])
      await error(await readEvents({ id }, path), 400, 'INVALID_REQUEST');
    for (const query of [
      'kind=AI_ACTION',
      'action=PIN_SEARCH',
      'limit=',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'limit=1&limit=2',
      'offset=-1',
      'offset=1e2',
      'offset=abc',
      'offset=0&offset=1',
      'offset=9007199254740992',
    ])
      await error(await readEvents(c, path, query), 400, 'INVALID_REQUEST');
    assert.deepEqual(await readBody(await readEvents(c, path, 'offset=9007199254740991')), {
      data: [],
      hasNext: false,
      total_count: 0,
    });
  }
});

test('PIN and previous-order actions page independently from speech/results and retain full-call order and seconds', async () => {
  const c = await createCall();
  const values = Array.from({ length: 120 }, (_, index) =>
    event(10 + index * 2, {
      offsetSeconds:
        index === 0 ? 0 : index === 1 ? null : index === 2 ? Number.MAX_SAFE_INTEGER : 31,
      payload: {
        action: index % 2 ? 'PREVIOUS_ORDER_SEARCH' : 'PIN_SEARCH',
        summaryText: index % 2 ? '지난주 김담당 주문 2건' : 'PIN 별칭 본사 1건',
        orderSeq: null,
      },
    }),
  );
  for (let index = 100; index >= 0; index -= 50)
    await success(await post(c, values.slice(index, index + 50).toReversed()));
  await success(
    await post(c, [
      business(5),
      utterance(1, 1, { offsetSeconds: 0 }),
      utterance(3, 2, { offsetSeconds: null }),
    ]),
  );
  const other = await createCall();
  await success(await post(other, [event(), business(2), utterance(3)]));
  const actual = [];
  for (let offset = 0; offset < 120; offset += 37) {
    const page = await readBody(await readEvents(c, 'actions', `limit=37&offset=${offset}`));
    assert.equal(page.hasNext, offset + 37 < 120);
    actual.push(...page.data);
  }
  assert.deepEqual(
    actual,
    values.map((value) => ({
      eventId: value.eventId,
      eventOrder: value.eventOrder,
      occurredAt: '2026-10-31T01:00:31.000Z',
      offsetSeconds: value.offsetSeconds,
      ...value.payload,
    })),
  );
  assert.deepEqual(await readBody(await readEvents(c, 'actions', 'offset=120')), {
    data: [],
    hasNext: false,
    total_count: 120,
  });
  const processing = await readBody(await readEvents(c, 'processing-results'));
  assert.equal(processing.data.length, 1);
  assert.equal(processing.data[0].eventOrder, 5);
  assert.equal(processing.data[0].questionText, null);
  assert.equal(processing.data[0].answerText, null);
  await success(await post(c, [business(6), business(7)]));
  const resultPage = await readBody(await readEvents(c, 'processing-results', 'limit=2'));
  assert.deepEqual(
    resultPage.data.map(({ eventOrder }) => eventOrder),
    [5, 6],
  );
  assert.equal(resultPage.hasNext, true);
  const lastResultPage = await readBody(
    await readEvents(c, 'processing-results', 'limit=2&offset=2'),
  );
  assert.deepEqual(
    lastResultPage.data.map(({ eventOrder }) => eventOrder),
    [7],
  );
  assert.equal(lastResultPage.hasNext, false);
  const transcript = await readBody(await readEvents(c, 'transcript'));
  assert.deepEqual(
    transcript.data.map(({ offsetSeconds }) => offsetSeconds),
    [0, null],
  );
  const detail = await (
    await fetch(`${base}/api/calls/${c.id}`, { headers: { Cookie: cookie } })
  ).json();
  assert.equal(detail.data.aiActionCount, 120);
  const late = event(9, { offsetSeconds: null });
  await success(await post(c, [late]));
  const refreshed = await readBody(await readEvents(c, 'actions', 'limit=1'));
  assert.equal(refreshed.data[0].eventId, late.eventId);
  assert.equal(refreshed.data[0].eventOrder, 9);
  assert.equal(refreshed.data[0].offsetSeconds, null);
  assert.equal(refreshed.hasNext, true);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /지난주 김담당|PIN 별칭 본사|민감-이벤트-본문|rtc_events_|Bearer /,
  );
});

test('FAQ results reference same-batch customer/AI speech and retain actual answers after FAQ edit or deletion', async () => {
  const c = await createCall();
  const faqId = await createFaq();
  const ids = Array.from({ length: 3 }, () => randomUUID()).sort();
  const result = { ...faqResult(3, faqId), eventId: ids[0] };
  const question = utterance(1, 1, {
    eventId: ids[1],
    payload: {
      utteranceOrder: 1,
      speaker: 'CUSTOMER',
      utteranceText: ' 민감-이벤트-본문: 착불 요금은요?\n',
      lastSentenceSeq: 1,
    },
  });
  const answer = utterance(2, 2, {
    eventId: ids[2],
    payload: {
      utteranceOrder: 2,
      speaker: 'AI',
      utteranceText: ' 민감-이벤트-본문: 실제 안내한 답변\n',
      lastSentenceSeq: 1,
    },
  });
  const search = event(4, {
    payload: { action: 'FAQ_SEARCH', summaryText: 'FAQ 검색 1건', orderSeq: null },
  });
  const values = [result, question, answer, search];
  await Promise.all(
    [post(c, values), post(c, values, { base: secondBase })].map(async (promise) =>
      success(await promise),
    ),
  );
  const beforeRows = await rows(c.id);
  const beforeAudits = await audits(c.id);
  const body = await readBody(await readEvents(c, 'processing-results'));
  assert.deepEqual(body, {
    data: [
      {
        eventId: result.eventId,
        eventOrder: 3,
        occurredAt: '2026-10-31T01:00:31.000Z',
        offsetSeconds: 31,
        action: 'FAQ_ANSWERED',
        orderSeq: null,
        unansweredQuestionSeq: null,
        summaryText: 'FAQ 안내 완료',
        unansweredReason: null,
        faqEntrySeq: faqId,
        faqEntrySeqs: [faqId],
        questionUtteranceOrder: 1,
        answerUtteranceOrder: 2,
        questionText: question.payload.utteranceText,
        answerText: answer.payload.utteranceText,
      },
    ],
    hasNext: false,
    total_count: 1,
  });
  assert.equal((await readBody(await readEvents(c, 'actions'))).data.length, 1);
  await pool.query(
    "UPDATE faq_entries SET question='수정된 FAQ',answer='수정된 답변' WHERE faq_entry_seq=$1",
    [faqId],
  );
  assert.deepEqual(await readBody(await readEvents(c, 'processing-results')), body);
  await pool.query('DELETE FROM faq_entries WHERE faq_entry_seq=$1', [faqId]);
  assert.deepEqual(await readBody(await readEvents(c, 'processing-results')), body);
  await success(
    await post(
      c,
      values.toReversed().map((value) => ({
        ...value,
        payload: Object.fromEntries(Object.entries(value.payload).reverse()),
      })),
    ),
  );
  assert.deepEqual(await rows(c.id), beforeRows);
  assert.deepEqual(await audits(c.id), beforeAudits);
});

test('FAQ references validate within the selected call and failures roll back the whole new batch', async () => {
  const faqId = await createFaq();
  const foreign = await createCall();
  await success(
    await post(foreign, [
      utterance(1),
      utterance(2, 2, {
        payload: {
          utteranceOrder: 2,
          speaker: 'AI',
          utteranceText: '다른 통화 답변',
          lastSentenceSeq: 1,
        },
      }),
    ]),
  );
  for (const [change, status, code] of [
    [{ questionUtteranceOrder: 999 }, 404, 'NOT_FOUND'],
    [{ answerUtteranceOrder: 999 }, 404, 'NOT_FOUND'],
    [{ questionUtteranceOrder: 2 }, 422, 'VALIDATION_FAILED'],
    [{ answerUtteranceOrder: 1 }, 422, 'VALIDATION_FAILED'],
    [{ orderSeq: 1 }, 422, 'VALIDATION_FAILED'],
    [{ unansweredQuestionSeq: 1 }, 422, 'VALIDATION_FAILED'],
  ]) {
    const c = await createCall();
    await error(
      await post(c, [
        event(4),
        faqResult(3, faqId, change),
        utterance(1),
        utterance(2, 2, {
          payload: { utteranceOrder: 2, speaker: 'AI', utteranceText: '답변', lastSentenceSeq: 1 },
        }),
      ]),
      status,
      code,
    );
    assert.deepEqual(await rows(c.id), []);
    assert.equal(
      (await pool.query('SELECT 1 FROM call_utterances WHERE call_session_seq=$1', [c.id]))
        .rowCount,
      0,
    );
    assert.equal((await audits(c.id)).length, 0);
  }
  const c = await createCall();
  await error(await post(c, [faqResult(3, faqId)]), 404, 'NOT_FOUND');
  await error(
    await post(c, [business(1, { payload: { ...business(1).payload, faqEntrySeq: faqId } })]),
    400,
    'INVALID_REQUEST',
  );
});

test('unanswered result reads preserve references while hiding deleted question text', async () => {
  const c = await createCall();
  const id = await createQuestion(c.id);
  await success(
    await post(c, [
      business(7, {
        payload: {
          action: 'QUESTION_UNANSWERED',
          orderSeq: null,
          unansweredQuestionSeq: id,
          summaryText: '미답변 기록',
        },
      }),
    ]),
  );
  const first = await readBody(await readEvents(c, 'processing-results'));
  assert.equal(first.data[0].questionText, '테스트 미답변');
  assert.equal(first.data[0].answerText, null);
  await pool.query(
    "UPDATE unanswered_questions SET status='REGISTERED',faq_entry_seq=$2,faq_conversion_hash=$3,registered_at=clock_timestamp() WHERE unanswered_question_seq=$1",
    [id, await createFaq(), 'c'.repeat(64)],
  );
  assert.deepEqual(await readBody(await readEvents(c, 'processing-results')), first);
  await pool.query(
    "UPDATE unanswered_questions SET status='DELETED',question_text=NULL,faq_entry_seq=NULL,faq_conversion_hash=NULL,registered_at=NULL,deleted_at=clock_timestamp() WHERE unanswered_question_seq=$1",
    [id],
  );
  const next = await readBody(await readEvents(c, 'processing-results'));
  assert.equal(next.data[0].questionText, null);
  assert.equal(next.data[0].unansweredQuestionSeq, id);
  assert.equal(next.data[0].faqEntrySeq, null);
});

test('read failures use the common error response instead of returning a successful empty page', async (t) => {
  const c = await createCall();
  const { CallEventsRepository } = require('../dist/call-insights/call-events.repository');
  const repository = apps[0].get(CallEventsRepository);
  for (const [path, method] of [
    ['actions', 'findActions'],
    ['processing-results', 'findProcessingResults'],
  ]) {
    const mock = t.mock.method(repository, method, async () => {
      throw new Error('민감-이벤트-본문 SELECT secret');
    });
    try {
      await error(await readEvents(c, path), 500, 'INTERNAL_ERROR');
    } finally {
      mock.mock.restore();
    }
  }
});

test('delayed FAQ results use logical FAQ IDs and saved speech even after the FAQ was deleted before first delivery', async () => {
  const deletedId = await createFaq();
  await pool.query('DELETE FROM faq_entries WHERE faq_entry_seq=$1', [deletedId]);
  for (const faqId of [deletedId, 2147483647]) {
    const c = await createCall();
    const question = utterance(1);
    const answer = utterance(2, 2, {
      payload: {
        utteranceOrder: 2,
        speaker: 'AI',
        utteranceText: '통화 당시 실제 답변',
        lastSentenceSeq: 1,
      },
    });
    const result = faqResult(3, faqId);
    const values = [result, answer, question];
    await success(await post(c, values));
    const before = await rows(c.id);
    const body = await readBody(await readEvents(c, 'processing-results'));
    assert.equal(body.total_count, 1);
    assert.equal(body.data[0].faqEntrySeq, faqId);
    assert.equal(body.data[0].questionText, question.payload.utteranceText);
    assert.equal(body.data[0].answerText, answer.payload.utteranceText);
    await success(await post(c, values.toReversed()));
    assert.deepEqual(await rows(c.id), before);
  }
});
