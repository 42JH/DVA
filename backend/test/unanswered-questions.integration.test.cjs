require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { request: httpRequest } = require('node:http');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.SWAGGER_ENABLED = 'true';
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const apps = [],
  logs = [];
let base, secondBase, config, audit, cookie, adminId;

async function createCall(ended = false) {
  const providerCallId = 'rtc_unanswered_' + randomUUID();
  const id = (
    await pool.query(
      'INSERT INTO call_sessions(provider_call_id,started_at,ended_at) VALUES($1,$2,$3) RETURNING call_session_seq',
      [
        providerCallId,
        ended ? new Date('2026-10-31T01:00:00Z') : null,
        ended ? new Date('2026-10-31T01:03:00Z') : null,
      ],
    )
  ).rows[0].call_session_seq;
  return { id, providerCallId };
}
const input = (call, changes = {}) => ({
  eventId: randomUUID(),
  callSessionSeq: call.id,
  providerCallId: call.providerCallId,
  questionText: ' 미답변-민감문구: 주말 수거 "문의"\n원문 \\ 😊 ',
  occurredAt: '2026-10-31T10:01:20+09:00',
  offsetSeconds: 80,
  ...changes,
});
const post = (body, options = {}) =>
  fetch((options.base || base) + '/api/ai/unanswered-questions', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: JSON.stringify(body),
  });
async function success(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.deepEqual(Object.keys(body.data), ['unansweredQuestionSeq']);
  assert.ok(
    Number.isInteger(body.data.unansweredQuestionSeq) && body.data.unansweredQuestionSeq > 0,
  );
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  return body.data.unansweredQuestionSeq;
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.doesNotMatch(JSON.stringify(body), /미답변-민감문구|rtc_unanswered_|SELECT |INSERT INTO/);
}
async function questions(callId) {
  return (
    await pool.query(
      'SELECT * FROM unanswered_questions WHERE call_session_seq=$1 ORDER BY unanswered_question_seq',
      [callId],
    )
  ).rows;
}
async function audits(id) {
  return (
    await pool.query(
      "SELECT * FROM audit_logs WHERE action='UNANSWERED_QUESTION_RECORDED' AND target_type='UNANSWERED_QUESTION' AND target_seq=$1 AND result='SUCCESS'",
      [id],
    )
  ).rows;
}
before(async () => {
  await migrate(pool);
  const { AppModule } = require('../dist/app.module');
  const { configureApplication } = require('../dist/configure-application');
  const { AuditService } = require('../dist/audit/audit.service');
  for (let i = 0; i < 2; i++) {
    const app = await NestFactory.create(AppModule, { logger: false });
    apps.push(app);
    configureApplication(app, { log: (value) => logs.push(value) });
    await app.listen(0, '127.0.0.1');
  }
  base = await apps[0].getUrl();
  secondBase = await apps[1].getUrl();
  config = apps[0].get(ConfigService);
  audit = apps[0].get(AuditService);
  adminId = (
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'미답변 관리자','test-only','SYSTEM_ADMIN','ACTIVE') RETURNING admin_user_seq",
      ['unq' + randomUUID().replaceAll('-', '').slice(0, 16)],
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

test('collection requires its service token even with an admin cookie and fails closed when disabled', async () => {
  const c = await createCall();
  for (const headers of [
    { Authorization: '' },
    { Authorization: 'Bearer wrong' },
    { Authorization: '', Cookie: cookie, Origin: process.env.CORS_ORIGINS },
  ])
    await error(await post(input(c), { headers }), 401, 'UNAUTHORIZED');
  config.set('AI_INSIGHTS_TOKEN', '');
  try {
    await error(await post(input(c)), 503, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    config.set('AI_INSIGHTS_TOKEN', token);
  }
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(
      base + '/api/ai/unanswered-questions',
      { method: 'POST', headers: { Authorization: ['Bearer ' + token, 'Bearer ' + token] } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 401);
  assert.deepEqual(await questions(c.id), []);
});

test('new questions return 201 with OPEN defaults, original text and one atomic AI audit without changing the call', async () => {
  const c = await createCall(true);
  const beforeCall = (
    await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [c.id])
  ).rows[0];
  const body = input(c);
  const id = await success(await post(body), 201);
  const [row] = await questions(c.id);
  assert.equal(row.unanswered_question_seq, id);
  assert.equal(row.event_id, body.eventId);
  assert.equal(row.question_text, body.questionText);
  assert.equal(row.occurred_at.toISOString(), '2026-10-31T01:01:20.000Z');
  assert.equal(row.offset_seconds, '80');
  assert.equal(row.status, 'OPEN');
  assert.ok(row.created_at instanceof Date);
  assert.match(row.payload_hash, /^[a-f0-9]{64}$/);
  for (const name of ['faq_entry_seq', 'faq_conversion_hash', 'registered_at', 'deleted_at'])
    assert.equal(row[name], null);
  const recorded = await audits(id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].actor_type, 'AI');
  assert.equal(recorded[0].actor_seq, null);
  assert.deepEqual(recorded[0].metadata, {});
  assert.deepEqual(
    (await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [c.id])).rows[0],
    beforeCall,
  );
  for (const table of ['call_analyses', 'call_utterances', 'call_insight_events'])
    assert.equal(
      (await pool.query(`SELECT 1 FROM ${table} WHERE call_session_seq=$1`, [c.id])).rowCount,
      0,
    );
});

test('equivalent replay returns 200 and preserves creation time, hash, original text and success audit', async () => {
  const c = await createCall();
  const body = input(c);
  const id = await success(await post(body), 201);
  const beforeRows = await questions(c.id);
  const beforeAudits = await audits(id);
  const replay = Object.fromEntries(
    Object.entries({
      ...body,
      eventId: body.eventId.toUpperCase(),
      occurredAt: '2026-10-31T01:01:20.000Z',
    }).reverse(),
  );
  assert.equal(await success(await post(replay), 200), id);
  assert.deepEqual(await questions(c.id), beforeRows);
  assert.deepEqual(await audits(id), beforeAudits);
});

test('concurrent replay across two instances creates one question and one success audit', async () => {
  const c = await createCall();
  const body = input(c);
  const responses = await Promise.all(
    Array.from({ length: 12 }, async (_, index) => {
      const response = await post(body, { base: index % 2 ? secondBase : base });
      assert.ok([200, 201].includes(response.status), await response.clone().text());
      return { status: response.status, id: await success(response, response.status) };
    }),
  );
  assert.equal(responses.filter((value) => value.status === 201).length, 1);
  assert.equal(new Set(responses.map((value) => value.id)).size, 1);
  assert.equal((await questions(c.id)).length, 1);
  assert.equal((await audits(responses[0].id)).length, 1);
});

test('the same occurrence cannot change text, position, time or call, while equal text with a new ID is distinct', async () => {
  const c = await createCall();
  const other = await createCall();
  const body = input(c);
  await success(await post(body), 201);
  const beforeRows = await questions(c.id);
  for (const change of [
    { questionText: body.questionText + '변경' },
    { offsetSeconds: 81 },
    { offsetSeconds: null },
    { occurredAt: '2026-10-31T01:01:21Z' },
    { callSessionSeq: other.id, providerCallId: other.providerCallId },
  ])
    await error(await post({ ...body, ...change }), 409, 'EVENT_PAYLOAD_CONFLICT');
  assert.deepEqual(await questions(c.id), beforeRows);
  assert.deepEqual(await questions(other.id), []);
  const id = await success(await post({ ...body, eventId: randomUUID() }), 201);
  assert.notEqual(id, beforeRows[0].unanswered_question_seq);
  assert.equal((await questions(c.id)).length, 2);
});

test('missing calls and mismatched provider identity cannot collect or replay a question', async () => {
  const c = await createCall();
  const body = input(c);
  await error(await post({ ...body, callSessionSeq: 2147483647 }), 404, 'NOT_FOUND');
  await error(await post({ ...body, providerCallId: 'different-call' }), 403, 'FORBIDDEN');
  await success(await post(body), 201);
  await error(await post({ ...body, providerCallId: 'different-call' }), 403, 'FORBIDDEN');
  assert.equal((await questions(c.id)).length, 1);
});

test('registered and deleted questions remain in their workflow state when original occurrences replay', async () => {
  const c = await createCall();
  const body = input(c);
  const id = await success(await post(body), 201);
  const faqId = (
    await pool.query(
      "INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,category) VALUES('미답변 전환 테스트','답변',$1,'기타') RETURNING faq_entry_seq",
      [adminId],
    )
  ).rows[0].faq_entry_seq;
  await pool.query(
    "UPDATE unanswered_questions SET status='REGISTERED',faq_entry_seq=$2,faq_conversion_hash=$3,registered_at=clock_timestamp() WHERE unanswered_question_seq=$1",
    [id, faqId, 'c'.repeat(64)],
  );
  const registered = await questions(c.id);
  assert.equal(await success(await post(body), 200), id);
  assert.deepEqual(await questions(c.id), registered);
  await pool.query('DELETE FROM faq_entries WHERE faq_entry_seq=$1', [faqId]);
  assert.equal(await success(await post(body), 200), id);
  assert.deepEqual(await questions(c.id), registered);
  await pool.query(
    "UPDATE unanswered_questions SET status='DELETED',question_text=NULL,faq_entry_seq=NULL,faq_conversion_hash=NULL,registered_at=NULL,deleted_at=clock_timestamp() WHERE unanswered_question_seq=$1",
    [id],
  );
  const deleted = await questions(c.id);
  assert.equal(await success(await post(body), 200), id);
  assert.deepEqual(await questions(c.id), deleted);
  await error(
    await post({ ...body, questionText: body.questionText + '수정' }),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  assert.deepEqual(await questions(c.id), deleted);
  assert.equal(deleted[0].question_text, null);
  assert.equal((await audits(id)).length, 1);
});

test('HTTP enforces required fields, integer seconds, Unicode length and request size without creating invalid rows', async () => {
  const c = await createCall();
  for (const change of [
    { offsetSeconds: undefined },
    { offsetSeconds: 80.5 },
    { offsetSeconds: '80' },
    { offsetSeconds: -1 },
    { status: 'OPEN' },
    { offsetMs: 80000 },
    { callSessionSeq: '120' },
    { questionText: ' \n' },
    { questionText: 'x\u0000' },
    { questionText: 'x'.repeat(1001) },
    { occurredAt: '2026-02-30T10:00:00Z' },
  ])
    await error(await post(input(c, change)), 400, 'INVALID_REQUEST');
  await error(
    await post(input(c, { occurredAt: '2026-W44-6T10:00:00Z' })),
    422,
    'VALIDATION_FAILED',
  );
  await error(await post(input(c, { questionText: 'x'.repeat(110000) })), 413, 'PAYLOAD_TOO_LARGE');
  assert.deepEqual(await questions(c.id), []);
  for (const offsetSeconds of [0, null, Number.MAX_SAFE_INTEGER]) {
    const id = await success(
      await post(input(c, { offsetSeconds, questionText: '😊'.repeat(1000) })),
      201,
    );
    const row = (await questions(c.id)).find((value) => value.unanswered_question_seq === id);
    assert.equal(row.offset_seconds, offsetSeconds === null ? null : String(offsetSeconds));
    assert.equal(row.question_text, '😊'.repeat(1000));
  }
});

test('audit failure rolls back the question and retry can create it once', async (t) => {
  const c = await createCall();
  const body = input(c);
  const original = audit.recordSuccess.bind(audit);
  const mock = t.mock.method(audit, 'recordSuccess', async (event, client) => {
    if (event.action === 'UNANSWERED_QUESTION_RECORDED')
      throw new Error('미답변-민감문구 audit failure');
    return original(event, client);
  });
  try {
    await error(await post(body), 500, 'INTERNAL_ERROR');
  } finally {
    mock.mock.restore();
  }
  assert.deepEqual(await questions(c.id), []);
  const id = await success(await post(body), 201);
  assert.equal((await audits(id)).length, 1);
});

test('collection has no 50-question cumulative limit and does not merge repeated question text', async () => {
  const c = await createCall();
  const ids = [];
  for (let index = 0; index < 51; index++) ids.push(await success(await post(input(c)), 201));
  assert.equal(new Set(ids).size, 51);
  assert.equal((await questions(c.id)).length, 51);
});

test('a collected question connects to processing results; event failure retries without losing the question', async (t) => {
  const c = await createCall();
  const body = input(c);
  const id = await success(await post(body), 201);
  const events = {
    providerCallId: c.providerCallId,
    events: [
      {
        eventId: randomUUID(),
        eventOrder: 1,
        kind: 'BUSINESS_RESULT',
        occurredAt: body.occurredAt,
        offsetSeconds: 80,
        payload: {
          action: 'QUESTION_UNANSWERED',
          orderSeq: null,
          unansweredQuestionSeq: id,
          summaryText: '미답변 질문 수집',
        },
      },
    ],
  };
  const sendEvent = () =>
    fetch(`${base}/api/ai/calls/${c.id}/events`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
    });
  const original = audit.recordSuccess.bind(audit);
  const mock = t.mock.method(audit, 'recordSuccess', async (event, client) => {
    if (event.action === 'CALL_EVENTS_RECORDED') throw new Error('event audit failure');
    return original(event, client);
  });
  try {
    await error(await sendEvent(), 500, 'INTERNAL_ERROR');
  } finally {
    mock.mock.restore();
  }
  assert.equal((await questions(c.id)).length, 1);
  assert.equal(
    (await pool.query('SELECT 1 FROM call_insight_events WHERE call_session_seq=$1', [c.id]))
      .rowCount,
    0,
  );
  const response = await sendEvent();
  assert.equal(response.status, 204, await response.clone().text());
  const read = () =>
    fetch(`${base}/api/calls/${c.id}/processing-results`, { headers: { Cookie: cookie } }).then(
      (response) => response.json(),
    );
  const results = await read();
  assert.equal(results.hasNext, false);
  assert.equal(results.data.length, 1);
  assert.equal(results.data[0].unansweredQuestionSeq, id);
  assert.equal(results.data[0].questionText, body.questionText);
  await pool.query(
    "UPDATE unanswered_questions SET status='DELETED',question_text=NULL,deleted_at=clock_timestamp() WHERE unanswered_question_seq=$1",
    [id],
  );
  assert.equal((await read()).data[0].questionText, null);
  assert.equal(await success(await post(body), 200), id);
  assert.equal((await read()).data[0].questionText, null);
});

test('OpenAPI documents service authentication, six fields and 201/200 without workflow state or milliseconds', async () => {
  const document = await (await fetch(base + '/api/docs-json')).json();
  const operation = document.paths['/api/ai/unanswered-questions'].post;
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  assert.equal(document.paths['/api/ai/unanswered-questions'].get, undefined);
  assert.deepEqual(document.paths['/api/unanswered-questions'].get.security, [
    { adminSession: [] },
  ]);
  for (const status of [
    '200',
    '201',
    '400',
    '401',
    '403',
    '404',
    '409',
    '413',
    '422',
    '500',
    '503',
  ])
    assert.ok(operation.responses[status], status);
  const schema = document.components.schemas.CreateUnansweredQuestionDto;
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    Object.keys(input({ id: 1, providerCallId: 'example' })).sort(),
  );
  assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort());
  assert.equal(schema.properties.questionText.maxLength, 1000);
  assert.equal(schema.properties.offsetSeconds.nullable, true);
  for (const property of Object.values(schema.properties)) assert.ok(property.description);
  assert.doesNotMatch(JSON.stringify(logs), /미답변-민감문구|rtc_unanswered_|Bearer /);
});
