require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { request: httpRequest } = require('node:http');
const { createTestPool, startTestApp } = require('./helpers/application.cjs');
const { ConfigService } = require('@nestjs/config');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.SWAGGER_ENABLED = 'false';
const pool = createTestPool();
const apps = [];
const logs = [];
let app, base, config, audit, cookie, versionSeq;
const input = (providerCallId, changes = {}) => ({
  providerCallId,
  startedAt: '2026-10-30T10:00:00+09:00',
  endedAt: '2026-10-30T10:03:40+09:00',
  aiPersonaVersionSeq: null,
  repeatQuestionCount: 2,
  hasComplaint: true,
  complaints: [
    {
      type: 'REPEATED_QUESTION',
      evidenceText: '분석-민감문구: 전화번호를 반복 질문해 불편함을 표현함',
      offsetSeconds: 31,
      utteranceOrders: [3, 4, 5, 6],
    },
  ],
  ...changes,
});
async function createCall() {
  const providerCallId = 'rtc_analysis_' + randomUUID();
  const result = await pool.query(
    `INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at)
     VALUES($1,'01012345678','2026-10-30T01:00:00Z','2026-10-30T01:00:03Z',
      '2026-10-30T01:03:43Z') RETURNING call_session_seq`,
    [providerCallId],
  );
  return { id: result.rows[0].call_session_seq, providerCallId };
}
const post = (id, body, headers = {}) =>
  fetch(`${base}/api/ai/calls/${id}/analysis`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  });
async function success(response) {
  assert.equal(response.status, 204, await response.clone().text());
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(JSON.stringify(body), /분석-민감문구|SELECT |INSERT INTO|rtc_analysis_/);
}

before(async () => {
  await migrate(pool);
  assert.ok((await pool.query("SELECT to_regclass('public.call_analyses') AS name")).rows[0].name);
  const { AuditService } = require('../dist/audit/audit.service');
  app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
  base = await app.getUrl();
  config = app.get(ConfigService);
  audit = app.get(AuditService);
  const adminId = (
    await pool.query(
      `INSERT INTO admin_users(login_id,name,password_hash,role,status)
       VALUES($1,'분석 테스트 관리자','not-for-login','SYSTEM_ADMIN','ACTIVE') RETURNING admin_user_seq`,
      ['anl' + randomUUID().replaceAll('-', '').slice(0, 16)],
    )
  ).rows[0].admin_user_seq;
  const sessionToken = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)', [
    createHash('sha256').update(sessionToken).digest('hex'),
    adminId,
  ]);
  cookie = 'dva_session=' + sessionToken;
  const personaId = (
    await pool.query('INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq', [
      'analysis-' + randomUUID(),
    ])
  ).rows[0].ai_persona_seq;
  versionSeq = (
    await pool.query(
      `INSERT INTO ai_persona_versions(ai_persona_seq,version,prompt_text,name,turn_wait_level,status)
       VALUES($1,1,'테스트 원문','분석 테스트 설정','NORMAL','INACTIVE') RETURNING ai_persona_version_seq`,
      [personaId],
    )
  ).rows[0].ai_persona_version_seq;
});
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});

test('service credential is mandatory even for an active administrator, and disabled config returns 503', async () => {
  const c = await createCall();
  for (const headers of [
    { Authorization: '' },
    { Authorization: 'Bearer wrong-token' },
    { Authorization: '', Cookie: cookie, Origin: process.env.CORS_ORIGINS },
  ])
    await error(await post(c.id, input(c.providerCallId), headers), 401, 'UNAUTHORIZED');
  config.set('AI_INSIGHTS_TOKEN', '');
  try {
    await error(await post(c.id, input(c.providerCallId)), 503, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    config.set('AI_INSIGHTS_TOKEN', token);
  }
  const duplicateStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(
      `${base}/api/ai/calls/${c.id}/analysis`,
      { method: 'POST', headers: { Authorization: ['Bearer ' + token, 'Bearer ' + token] } },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(duplicateStatus, 401);
  assert.equal(
    (await pool.query('SELECT 1 FROM call_analyses WHERE call_session_seq=$1', [c.id])).rowCount,
    0,
  );
});

test('final analysis stores actual version and normalized evidence, preserving PBX call and persona state', async () => {
  const c = await createCall();
  const callBefore = (
    await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [c.id])
  ).rows[0];
  const body = input(c.providerCallId, { aiPersonaVersionSeq: versionSeq });
  await success(await post(c.id, body));
  const stored = (await pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [c.id]))
    .rows[0];
  assert.equal(stored.ai_persona_version_seq, versionSeq);
  assert.equal(Object.hasOwn(stored, 'result'), false);
  assert.equal(stored.ai_started_at.toISOString(), '2026-10-30T01:00:00.000Z');
  assert.equal(stored.ai_ended_at.toISOString(), '2026-10-30T01:03:40.000Z');
  assert.equal(stored.repeat_question_count, 2);
  assert.equal(stored.has_complaint, true);
  assert.deepEqual(stored.complaints, body.complaints);
  assert.match(stored.payload_hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    (await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [c.id])).rows[0],
    callBefore,
  );
  assert.equal(
    (
      await pool.query('SELECT status FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [
        versionSeq,
      ])
    ).rows[0].status,
    'INACTIVE',
  );
  const events = (
    await pool.query(
      "SELECT * FROM audit_logs WHERE action='CALL_ANALYSIS_RECORDED' AND target_seq=$1 AND result='SUCCESS'",
      [c.id],
    )
  ).rows;
  assert.equal(events.length, 1);
  assert.equal(events[0].actor_type, 'AI');
  assert.deepEqual(events[0].metadata, {});
  assert.doesNotMatch(JSON.stringify(logs), /분석-민감문구|rtc_analysis_|Bearer /);
});

test('concurrent equivalent replays store one row and one success audit without resetting analysed_at', async () => {
  const c = await createCall();
  const body = input(c.providerCallId);
  await Promise.all(Array.from({ length: 12 }, async () => success(await post(c.id, body))));
  const first = (await pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [c.id]))
    .rows[0];
  const equivalent = Object.fromEntries(Object.entries(body).reverse());
  equivalent.startedAt = '2026-10-30T01:00:00.000Z';
  equivalent.endedAt = '2026-10-30T01:03:40.000Z';
  equivalent.complaints = [{ ...body.complaints[0], utteranceOrders: [6, 3, 5, 4] }];
  await success(await post(c.id, equivalent));
  assert.deepEqual(
    (await pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [c.id])).rows,
    [first],
  );
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM audit_logs WHERE action='CALL_ANALYSIS_RECORDED' AND target_seq=$1 AND result='SUCCESS'",
        [c.id],
      )
    ).rowCount,
    1,
  );
});

test('concurrent conflicting reports preserve the winner and reject the other with 409', async () => {
  const c = await createCall();
  const responses = await Promise.all([
    post(c.id, input(c.providerCallId, { repeatQuestionCount: 1 })),
    post(c.id, input(c.providerCallId, { repeatQuestionCount: 2 })),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [204, 409]);
  await error(
    responses.find((response) => response.status === 409),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM call_analyses WHERE call_session_seq=$1', [c.id])).rowCount,
    1,
  );
});

test('audit failure rolls back the new analysis so a valid retry can save it', async () => {
  const c = await createCall();
  const original = audit.recordSuccess;
  audit.recordSuccess = async () => {
    throw new Error('simulated-audit-storage-failure');
  };
  try {
    await error(await post(c.id, input(c.providerCallId)), 500, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(
    (await pool.query('SELECT 1 FROM call_analyses WHERE call_session_seq=$1', [c.id])).rowCount,
    0,
  );
  await success(await post(c.id, input(c.providerCallId)));
});

test('AI summary is stored as reported with the actual persona and replays never increment counts', async () => {
  const c = await createCall();
  const body = input(c.providerCallId, {
    aiPersonaVersionSeq: versionSeq,
    isNewCustomer: false,
    registeredParcelCount: 3,
    faqAnswerCount: 2,
    orderLookupCount: 1,
    cancelledParcelCount: 1,
    hasHandoffRequest: true,
    hasCallbackRequest: true,
  });
  await success(await post(c.id, body));
  const stored = (await pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [c.id]))
    .rows[0];
  assert.equal(stored.ai_persona_version_seq, versionSeq);
  assert.equal(stored.is_new_customer, false);
  assert.equal(stored.registered_parcel_count, 3);
  assert.equal(stored.faq_answer_count, 2);
  assert.equal(stored.order_lookup_count, 1);
  assert.equal(stored.cancelled_parcel_count, 1);
  assert.equal(stored.has_handoff_request, true);
  assert.equal(stored.has_callback_request, true);
  await Promise.all(Array.from({ length: 6 }, async () => success(await post(c.id, body))));
  for (const change of [
    { isNewCustomer: true },
    { registeredParcelCount: 4 },
    { faqAnswerCount: 3 },
    { orderLookupCount: 2 },
    { cancelledParcelCount: 2 },
    { hasHandoffRequest: false },
    { hasCallbackRequest: false },
  ])
    await error(await post(c.id, { ...body, ...change }), 409, 'EVENT_PAYLOAD_CONFLICT');
  assert.deepEqual(
    (await pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [c.id])).rows,
    [stored],
  );
});

test('callback is independent of handoff, survives ended calls and rejects invalid flags and deleted calls', async () => {
  const call = await createCall();
  const body = input(call.providerCallId, { hasHandoffRequest: false, hasCallbackRequest: true });
  for (const value of ['true', 1, {}, []])
    await error(
      await post(call.id, { ...body, hasCallbackRequest: value }),
      400,
      'INVALID_REQUEST',
    );
  await success(await post(call.id, body));
  await success(await post(call.id, body));
  const row = (
    await pool.query(
      'SELECT has_handoff_request,has_callback_request FROM call_analyses WHERE call_session_seq=$1',
      [call.id],
    )
  ).rows[0];
  assert.deepEqual(row, { has_handoff_request: false, has_callback_request: true });
  await pool.query(
    'UPDATE call_sessions SET deleted_at=clock_timestamp() WHERE call_session_seq=$1',
    [call.id],
  );
  await error(await post(call.id, body), 404, 'NOT_FOUND');
});
