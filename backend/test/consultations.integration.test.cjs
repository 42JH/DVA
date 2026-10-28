require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomInt, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.S3_RECORDINGS_BUCKET = '';
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const password = 'calls-test-only-password';
const origin = 'http://localhost:5173';
const logs = [];
const phoneNumber = () => '010' + randomInt(10000000, 100000000);
let app, base, passwordHash, operator;

async function account(role = 'OPERATOR') {
  const loginId = 'call' + randomUUID().replaceAll('-', '').slice(0, 16);
  const id = (
    await pool.query(
      `INSERT INTO admin_users(login_id,name,password_hash,role,status)
     VALUES($1,'통화 테스트 관리자',$2,$3,'ACTIVE') RETURNING admin_user_seq`,
      [loginId, passwordHash, role],
    )
  ).rows[0].admin_user_seq;
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return { id, headers: { Cookie: response.headers.get('set-cookie').split(';')[0] } };
}
async function call(input = {}) {
  const row = {
    providerCallId: 'rtc_test_' + randomUUID(),
    callerPhoneNumber: phoneNumber(),
    orderSeq: null,
    startedAt: '2026-10-28T01:00:00.000Z',
    endedAt: '2026-10-28T01:03:00.000Z',
    endReason: null,
    ...input,
  };
  const id = (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,order_seq,started_at,ended_at,end_reason)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING call_session_seq`,
      [
        row.providerCallId,
        row.callerPhoneNumber,
        row.orderSeq,
        row.startedAt,
        row.endedAt,
        row.endReason,
      ],
    )
  ).rows[0].call_session_seq;
  return { callSessionSeq: id, ...row, handoff: null };
}
async function handoff(row, status = 'REQUESTED') {
  const value = {
    reason: '고객 요청',
    status,
    assignedAdminUserSeq: null,
    summaryText: null,
    requestedAt: '2026-10-28T01:02:00.000Z',
  };
  const id = (
    await pool.query(
      `INSERT INTO handoff_requests(call_session_seq,reason,status,requested_at)
     VALUES($1,$2,$3,$4) RETURNING handoff_request_seq`,
      [row.callSessionSeq, value.reason, status, value.requestedAt],
    )
  ).rows[0].handoff_request_seq;
  row.handoff = { handoffRequestSeq: id, ...value };
}
const list = (query = {}, headers = operator.headers) =>
  fetch(
    base +
      '/api/calls?' +
      (typeof query === 'string' ? query : new URLSearchParams(query).toString()),
    { headers },
  );
async function result(response, isList = true) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), isList ? ['data', 'hasNext'] : ['data', 'meta']);
  if (!isList) assert.ok(body.meta.requestId);
  return body;
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
}
before(async () => {
  // 기존 통합 검증이 적용한 격리 DB만 사용한다.
  assert.ok(
    (await pool.query("SELECT to_regclass('public.handoff_requests') AS name")).rows[0].name,
  );
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: (entry) => logs.push(entry) });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  passwordHash = await hashPassword(password);
  operator = await account();
});
after(async () => {
  if (app) await app.close();
  await pool.end();
});

test('call list requires a real administrator session, including AI/header callers', async () => {
  for (const headers of [
    {},
    { call_session_seq: '1' },
    { Authorization: 'Bearer test-only' },
    { Cookie: 'dva_session=' + '0'.repeat(64) },
  ])
    await error(await list({}, headers), 401, 'UNAUTHORIZED');
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const admin = role === 'OPERATOR' ? operator : await account(role);
    assert.deepEqual(
      await result(await list({ callerPhoneNumber: phoneNumber() }, admin.headers)),
      { data: [], hasNext: false },
    );
  }
});

test('pending administrators and expired sessions cannot read call records', async () => {
  const pending = await account();
  await pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [pending.id]);
  await error(await list({}, pending.headers), 401, 'UNAUTHORIZED');
  const expired = await account();
  await pool.query(
    "UPDATE admin_sessions SET created_at=clock_timestamp()-interval '10 hours',expires_at=clock_timestamp()-interval '1 second' WHERE admin_user_seq=$1",
    [expired.id],
  );
  await error(await list({}, expired.headers), 401, 'UNAUTHORIZED');
});

test('list preserves nullable call fields and distinguishes absent/requested/connected/failed handoffs', async () => {
  const phone = phoneNumber();
  const rows = [];
  for (const status of [null, 'REQUESTED', 'CONNECTED', 'FAILED']) {
    const row = await call({ callerPhoneNumber: phone });
    if (status) await handoff(row, status);
    rows.unshift(row);
  }
  assert.deepEqual(await result(await list({ callerPhoneNumber: phone })), {
    data: rows,
    hasNext: false,
  });
  for (const status of ['REQUESTED', 'CONNECTED', 'FAILED'])
    assert.deepEqual(
      (await result(await list({ callerPhoneNumber: phone, handoffStatus: status }))).data,
      rows.filter((row) => row.handoff?.status === status),
    );
  const unknown = await call({ callerPhoneNumber: phone, startedAt: null, endedAt: null });
  const data = (await result(await list({ callerPhoneNumber: phone }))).data;
  assert.deepEqual(data.at(-1), unknown);
  assert.equal(data.at(-1).endReason, null);
  assert.equal(Object.hasOwn(data.at(-1), 'status'), false);
});

test('list combines order, exact phone, end reason and handoff filters without changing stored data', async () => {
  const orderSeq = (await pool.query('INSERT INTO orders DEFAULT VALUES RETURNING order_seq'))
    .rows[0].order_seq;
  const row = await call({ orderSeq, endReason: 'customer_ended' });
  await handoff(row, 'CONNECTED');
  await call({ callerPhoneNumber: row.callerPhoneNumber, endReason: 'customer_ended' });
  const query = {
    orderSeq,
    callerPhoneNumber: row.callerPhoneNumber,
    endReason: row.endReason,
    handoffStatus: 'CONNECTED',
  };
  assert.deepEqual(await result(await list(query)), { data: [row], hasNext: false });
  for (const changed of [
    { endReason: 'CUSTOMER_ENDED' },
    { handoffStatus: 'FAILED' },
    { callerPhoneNumber: row.callerPhoneNumber.slice(0, -1) },
  ])
    assert.deepEqual(await result(await list({ ...query, ...changed })), {
      data: [],
      hasNext: false,
    });
  const literal = "test' OR true --";
  const quoted = await call({ endReason: literal });
  assert.deepEqual((await result(await list({ endReason: literal }))).data, [quoted]);
  assert.equal(
    (await pool.query('SELECT status FROM orders WHERE order_seq=$1', [orderSeq])).rows[0].status,
    'COLLECTING',
  );
});

test('date filters use actual started_at with inclusive from and exclusive to, without guessing missing times', async () => {
  const phone = phoneNumber();
  const first = await call({ callerPhoneNumber: phone });
  await call({ callerPhoneNumber: phone, startedAt: '2026-10-28T01:01:00.000Z' });
  await call({ callerPhoneNumber: phone, startedAt: null, endedAt: null });
  const rows = await result(
    await list({
      callerPhoneNumber: phone,
      from: '2026-10-28T10:00:00+09:00',
      to: '2026-10-28T10:01:00+09:00',
    }),
  );
  assert.deepEqual(rows, { data: [first], hasNext: false });
});

test('pagination is deterministic for equal timestamps and null times, with no duplicate handoff rows', async () => {
  const phone = phoneNumber();
  const first = await call({ callerPhoneNumber: phone });
  const second = await call({ callerPhoneNumber: phone });
  await handoff(second);
  const unknown = await call({ callerPhoneNumber: phone, startedAt: null, endedAt: null });
  const expected = [second, first, unknown];
  for (let offset = 0; offset < 3; offset++) {
    assert.deepEqual(await result(await list({ callerPhoneNumber: phone, limit: 1, offset })), {
      data: [expected[offset]],
      hasNext: offset < 2,
    });
  }
  assert.deepEqual(await result(await list({ callerPhoneNumber: phone, offset: 3 })), {
    data: [],
    hasNext: false,
  });
});

test('list rejects invalid, repeated and unsupported query fields', async () => {
  for (const query of [
    'orderSeq=0',
    'orderSeq=2147483648',
    'orderSeq=1e2',
    'orderSeq=1&orderSeq=2',
    'callerPhoneNumber=010-1234-5678',
    'callerPhoneNumber=',
    'endReason=',
    'endReason=%20',
    'handoffStatus=DONE',
    'handoffStatus=REQUESTED&handoffStatus=FAILED',
    'from=2026-02-30T00:00:00Z',
    'from=2026-10-28',
    'from=2026-10-28T00:00:00',
    'from=2026-10-29T00:00:00Z&to=2026-10-28T00:00:00Z',
    'from=2026-10-28T00:00:00Z&to=2026-10-28T00:00:00Z',
    'limit=0',
    'limit=101',
    'limit=',
    'offset=-1',
    'offset=1.5',
    'offset=9007199254740992',
    'customerSeq=1',
    'status=IN_PROGRESS',
    'unknown=true',
  ])
    await error(await list(query), 400, 'INVALID_REQUEST');
});

test('Swagger describes the list contract, cookie authentication and English module name without spec numbers', async () => {
  const spec = await (await fetch(base + '/api/docs-json')).json();
  const operation = spec.paths['/api/calls'].get;
  assert.deepEqual(operation.tags, ['Calls']);
  assert.equal(operation.summary, '통화 목록 조회');
  assert.ok(operation.description);
  assert.deepEqual(operation.security, [{ adminSession: [] }]);
  const parameters = operation.parameters.map(({ name }) => name);
  assert.equal(new Set(parameters).size, parameters.length);
  assert.deepEqual(
    parameters.sort(),
    [
      'orderSeq',
      'callerPhoneNumber',
      'from',
      'to',
      'endReason',
      'handoffStatus',
      'limit',
      'offset',
    ].sort(),
  );
  for (const name of ['CallDto', 'HandoffDto', 'CallListResponseDto'])
    for (const property of Object.values(spec.components.schemas[name].properties))
      assert.ok(property.description, name);
  assert.equal(Object.hasOwn(spec.components.schemas.CallDto.properties, 'incomingAt'), false);
});

test('request logs do not contain phone numbers, provider IDs or search text', async () => {
  const row = await call({ endReason: randomUUID() });
  await result(await list({ callerPhoneNumber: row.callerPhoneNumber, endReason: row.endReason }));
  const text = JSON.stringify(logs);
  for (const value of [row.callerPhoneNumber, row.providerCallId, row.endReason])
    assert.equal(text.includes(value), false);
});

const detail = (id, headers = operator.headers) => fetch(base + '/api/calls/' + id, { headers });
async function recording(callId) {
  const row = (
    await pool.query(
      `INSERT INTO recordings(call_session_seq,object_key)
     VALUES($1,$2) RETURNING recording_seq AS "recordingSeq",created_at AS "createdAt"`,
      [callId, 'recordings/test-' + randomUUID()],
    )
  ).rows[0];
  return { ...row, createdAt: row.createdAt.toISOString() };
}

test('detail returns only the selected call, saved handoff data and its recordings without object keys', async () => {
  const orderSeq = (await pool.query('INSERT INTO orders DEFAULT VALUES RETURNING order_seq'))
    .rows[0].order_seq;
  const row = await call({ orderSeq });
  await handoff(row, 'CONNECTED');
  const summaryText = '고객 배송지 문의';
  await pool.query(
    'UPDATE handoff_requests SET assigned_admin_user_seq=$2,summary_text=$3 WHERE call_session_seq=$1',
    [row.callSessionSeq, operator.id, summaryText],
  );
  Object.assign(row.handoff, { assignedAdminUserSeq: operator.id, summaryText });
  const first = await recording(row.callSessionSeq);
  const second = await recording(row.callSessionSeq);
  await recording((await call()).callSessionSeq);
  const body = await result(await detail(row.callSessionSeq), false);
  assert.deepEqual(body.data, { call: row, recordings: [first, second] });
  assert.equal(JSON.stringify(body).includes('objectKey'), false);
  assert.equal(JSON.stringify(body).includes('recordings/test-'), false);
  assert.equal(JSON.stringify(logs).includes(summaryText), false);
});

test('detail preserves missing times, phone, order and handoff while returning an empty recording list', async () => {
  const row = await call({ callerPhoneNumber: null, startedAt: null, endedAt: null });
  assert.deepEqual((await result(await detail(row.callSessionSeq), false)).data, {
    call: row,
    recordings: [],
  });
});

test('detail distinguishes an absent call from an existing call without recordings', async () => {
  await error(await detail(2147483647), 404, 'NOT_FOUND');
  const row = await call();
  assert.deepEqual((await result(await detail(row.callSessionSeq), false)).data.recordings, []);
});

test('detail validates database IDs and checks the session before revealing existence', async () => {
  const row = await call();
  for (const id of [row.callSessionSeq, 2147483647]) {
    await error(await detail(id, {}), 401, 'UNAUTHORIZED');
    await error(
      await detail(id, { call_session_seq: String(row.callSessionSeq) }),
      401,
      'UNAUTHORIZED',
    );
  }
  for (const id of ['0', '-1', '1.5', '1e2', '2147483648', row.providerCallId])
    await error(await detail(id), 400, 'INVALID_REQUEST');
});

test('Swagger documents call detail IDs, nullable handoff and recording metadata without exposing storage paths', async () => {
  const spec = await (await fetch(base + '/api/docs-json')).json();
  const operation = spec.paths['/api/calls/{id}'].get;
  assert.deepEqual(operation.tags, ['Calls']);
  assert.equal(operation.summary, '통화 상세 조회');
  assert.deepEqual(operation.security, [{ adminSession: [] }]);
  assert.equal(operation.parameters.length, 1);
  assert.equal(operation.parameters[0].name, 'id');
  assert.match(operation.parameters[0].description, /call_session_seq/);
  assert.ok(operation.responses['404']);
  for (const name of ['CallDetailDto', 'CallDetailResponseDto', 'RecordingDto'])
    for (const property of Object.values(spec.components.schemas[name].properties))
      assert.ok(property.description, name);
  assert.deepEqual(Object.keys(spec.components.schemas.RecordingDto.properties).sort(), [
    'createdAt',
    'recordingSeq',
  ]);
});

const transcript = (id, query = {}, headers = operator.headers) =>
  fetch(
    base +
      '/api/calls/' +
      id +
      '/transcript?' +
      (typeof query === 'string' ? query : new URLSearchParams(query).toString()),
    { headers },
  );
async function utterance(callId, order, text = '발화 ' + randomUUID()) {
  const row = (
    await pool.query(
      `INSERT INTO call_utterances(call_session_seq,utterance_order,speaker,utterance_text,last_sentence_seq)
     VALUES($1,$2,$3,$4,1) RETURNING call_utterance_seq AS "callUtteranceSeq",utterance_order AS "utteranceOrder",
     speaker,utterance_text AS "utteranceText",last_sentence_seq AS "lastSentenceSeq",received_at AS "receivedAt"`,
      [callId, order, order % 2 ? 'CUSTOMER' : 'AI', text],
    )
  ).rows[0];
  return { ...row, receivedAt: row.receivedAt.toISOString() };
}

test('transcript sorts by utterance order rather than insert time and never includes another call', async () => {
  const row = await call();
  const third = await utterance(row.callSessionSeq, 3);
  const first = await utterance(row.callSessionSeq, 1, '택배 요청\n<script>plain text</script>');
  const second = await utterance(row.callSessionSeq, 2);
  await utterance((await call()).callSessionSeq, 1);
  assert.deepEqual(await result(await transcript(row.callSessionSeq)), {
    data: [first, second, third],
    hasNext: false,
  });
  for (let offset = 0; offset < 3; offset++)
    assert.deepEqual(await result(await transcript(row.callSessionSeq, { limit: 1, offset })), {
      data: [[first, second, third][offset]],
      hasNext: offset < 2,
    });
  assert.deepEqual(await result(await transcript(row.callSessionSeq, { offset: 3 })), {
    data: [],
    hasNext: false,
  });
  assert.equal(JSON.stringify(logs).includes(first.utteranceText), false);
});

test('transcript returns the latest saved snapshot and its sentence sequence without changing the received time', async () => {
  const row = await call();
  const first = await utterance(row.callSessionSeq, 1);
  const updated = first.utteranceText + '\n추가 문장';
  await pool.query(
    'UPDATE call_utterances SET utterance_text=$2,last_sentence_seq=2 WHERE call_utterance_seq=$1',
    [first.callUtteranceSeq, updated],
  );
  assert.deepEqual((await result(await transcript(row.callSessionSeq))).data, [
    { ...first, utteranceText: updated, lastSentenceSeq: 2 },
  ]);
});

test('transcript distinguishes uncollected STT from a nonexistent call even when a recording exists', async () => {
  const row = await call();
  await recording(row.callSessionSeq);
  assert.deepEqual(await result(await transcript(row.callSessionSeq)), {
    data: [],
    hasNext: false,
  });
  await error(await transcript(2147483647), 404, 'NOT_FOUND');
});

test('transcript requires an active administrator and validates call IDs and pagination', async () => {
  const row = await call();
  for (const headers of [
    {},
    { call_session_seq: String(row.callSessionSeq) },
    { Cookie: 'dva_session=' + '0'.repeat(64) },
  ])
    await error(await transcript(row.callSessionSeq, {}, headers), 401, 'UNAUTHORIZED');
  for (const id of ['0', '-1', '1.5', '2147483648'])
    await error(await transcript(id), 400, 'INVALID_REQUEST');
  for (const query of [
    'limit=101',
    'limit=0',
    'limit=1&limit=2',
    'offset=-1',
    'offset=1e2',
    'speaker=AI',
    'orderSeq=1',
  ])
    await error(await transcript(row.callSessionSeq, query), 400, 'INVALID_REQUEST');
});

test('Swagger documents transcript pagination, speakers and the difference between received time and audio position', async () => {
  const spec = await (await fetch(base + '/api/docs-json')).json();
  const operation = spec.paths['/api/calls/{id}/transcript'].get;
  assert.deepEqual(operation.tags, ['Calls']);
  assert.equal(operation.summary, '통화 대화 내용 조회');
  assert.deepEqual(operation.security, [{ adminSession: [] }]);
  assert.deepEqual(operation.parameters.map(({ name }) => name).sort(), ['id', 'limit', 'offset']);
  assert.ok(operation.responses['404']);
  assert.deepEqual(spec.components.schemas.UtteranceDto.properties.speaker.enum, [
    'CUSTOMER',
    'AI',
  ]);
  assert.match(spec.components.schemas.UtteranceDto.properties.receivedAt.description, /최초 수신/);
  for (const name of ['UtteranceDto', 'TranscriptResponseDto'])
    for (const property of Object.values(spec.components.schemas[name].properties))
      assert.ok(property.description, name);
});
