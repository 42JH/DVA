require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomInt, randomUUID } = require('node:crypto');
const { createTestPool, startTestApp } = require('./helpers/application.cjs');
const { ConfigService } = require('@nestjs/config');
const { S3Client, HeadObjectCommand } = require('@aws-sdk/client-s3');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'false';
process.env.CORS_ORIGINS = 'http://localhost:5173';
process.env.S3_RECORDINGS_BUCKET = '';
const { hashPassword } = require('../dist/auth/password');
const { callerPhone } = require('../dist/common/caller-phone');
const { RecordingPlaybackService } = require('../dist/consultations/recording-playback.service');
const pool = createTestPool();
const apps = [];
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
    ...input,
  };
  const id = (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,order_seq,started_at,ended_at)
     VALUES($1,$2,$3,$4,$5) RETURNING call_session_seq`,
      [row.providerCallId, row.callerPhoneNumber, row.orderSeq, row.startedAt, row.endedAt],
    )
  ).rows[0].call_session_seq;
  return {
    callSessionSeq: id,
    ...row,
    orderStatus: row.orderSeq === null ? null : 'COLLECTING',
    orderTotalAmount: null,
    customerSeq: null,
    customerName: null,
    organizationName: null,
    analysis: null,
    analysisStatus: 'PENDING',
    recordedAt: null,
  };
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
  assert.deepEqual(
    Object.keys(body).sort(),
    isList ? ['data', 'hasNext', 'total_count'] : ['data', 'meta'],
  );
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
  assert.ok((await pool.query("SELECT to_regclass('public.call_sessions') AS name")).rows[0].name);
  app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
  base = await app.getUrl();
  passwordHash = await hashPassword(password);
  operator = await account();
});
after(async () => {
  for (const application of apps) await application.close();
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
      { data: [], hasNext: false, total_count: 0 },
    );
  }
});

test('list combines order, exact phone and order status filters and treats SQL search text literally', async () => {
  const orderSeq = (await pool.query('INSERT INTO orders DEFAULT VALUES RETURNING order_seq'))
    .rows[0].order_seq;
  const row = await call({ orderSeq });
  await call({ callerPhoneNumber: row.callerPhoneNumber });
  const query = {
    orderSeq,
    callerPhoneNumber: row.callerPhoneNumber,
    orderStatus: 'COLLECTING',
  };
  assert.deepEqual(await result(await list(query)), {
    data: [row],
    hasNext: false,
    total_count: 1,
  });
  for (const changed of [
    { orderStatus: 'CANCELLED' },
    { callerPhoneNumber: row.callerPhoneNumber.slice(0, -1) },
  ])
    assert.deepEqual(await result(await list({ ...query, ...changed })), {
      data: [],
      hasNext: false,
      total_count: 0,
    });
  const literal = "test' OR true --";
  const quoted = await call();
  const customer = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE') RETURNING customer_seq",
      [literal, quoted.callerPhoneNumber],
    )
  ).rows[0].customer_seq;
  await pool.query('UPDATE call_sessions SET customer_seq=$2 WHERE call_session_seq=$1', [
    quoted.callSessionSeq,
    customer,
  ]);
  Object.assign(quoted, { customerSeq: customer, customerName: literal });
  assert.deepEqual((await result(await list({ q: literal }))).data, [quoted]);
  assert.equal(
    (await pool.query('SELECT status FROM orders WHERE order_seq=$1', [orderSeq])).rows[0].status,
    'COLLECTING',
  );
});

test('list searches international caller numbers preserved by the AI flow without dropping the country prefix', async () => {
  const phone = callerPhone('+1' + randomInt(2000000000, 10000000000));
  const row = await call({ callerPhoneNumber: phone });
  assert.deepEqual(await result(await list({ callerPhoneNumber: phone })), {
    data: [row],
    hasNext: false,
    total_count: 1,
  });
  assert.deepEqual(await result(await list({ callerPhoneNumber: phone.slice(1) })), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
});

test('pagination is deterministic for equal timestamps and null times', async () => {
  const phone = phoneNumber();
  const first = await call({ callerPhoneNumber: phone });
  const second = await call({ callerPhoneNumber: phone });
  const unknown = await call({ callerPhoneNumber: phone, startedAt: null, endedAt: null });
  const expected = [second, first, unknown];
  for (let offset = 0; offset < 3; offset++) {
    assert.deepEqual(await result(await list({ callerPhoneNumber: phone, limit: 1, offset })), {
      data: [expected[offset]],
      hasNext: offset < 2,
      total_count: 3,
    });
  }
  assert.deepEqual(await result(await list({ callerPhoneNumber: phone, offset: 3 })), {
    data: [],
    hasNext: false,
    total_count: 3,
  });
});

const detail = (id, headers = operator.headers) => fetch(base + '/api/calls/' + id, { headers });
const callInfo = ({ analysis, ...value }, recordedAt = null) => ({ ...value, recordedAt });
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

test('detail returns only the selected call and recordings with signed URLs', async (t) => {
  const { commands } = playbackStorage(t);
  const orderSeq = (await pool.query('INSERT INTO orders DEFAULT VALUES RETURNING order_seq'))
    .rows[0].order_seq;
  const row = await call({ orderSeq });
  const first = await recording(row.callSessionSeq);
  const second = await recording(row.callSessionSeq);
  await recording((await call()).callSessionSeq);
  const body = await result(await detail(row.callSessionSeq), false);
  assert.deepEqual(body.data.call, callInfo(row, first.createdAt));
  assert.equal(body.data.analysis, null);
  assert.deepEqual(
    body.data.recordings.map(({ recordingSeq, createdAt }) => ({ recordingSeq, createdAt })),
    [first, second],
  );
  assert.equal(commands.length, 2);
  for (const [index, saved] of body.data.recordings.entries()) {
    assert.equal(saved.playbackError, null);
    assert.equal(decodeURIComponent(new URL(saved.url).pathname), '/' + commands[index].Key);
    assert.ok(Date.parse(saved.expiresAt) > Date.now());
    assert.equal(JSON.stringify(logs).includes(saved.url), false);
  }
  assert.equal(JSON.stringify(body).includes('objectKey'), false);
});

test('detail distinguishes an absent call from an existing call without recordings', async () => {
  await error(await detail(2147483647), 404, 'NOT_FOUND');
  const row = await call();
  assert.deepEqual((await result(await detail(row.callSessionSeq), false)).data.recordings, []);
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
  return { ...row, receivedAt: row.receivedAt.toISOString(), offsetSeconds: null };
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
    total_count: 3,
  });
  for (let offset = 0; offset < 3; offset++)
    assert.deepEqual(await result(await transcript(row.callSessionSeq, { limit: 1, offset })), {
      data: [[first, second, third][offset]],
      hasNext: offset < 2,
      total_count: 3,
    });
  assert.deepEqual(await result(await transcript(row.callSessionSeq, { offset: 3 })), {
    data: [],
    hasNext: false,
    total_count: 3,
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
    total_count: 0,
  });
  await error(await transcript(2147483647), 404, 'NOT_FOUND');
});

function playbackStorage(t) {
  const service = app.get(RecordingPlaybackService);
  const config = app.get(ConfigService);
  const originalClient = service.s3;
  const commands = [];
  service.s3 = new S3Client({
    region: 'ap-northeast-2',
    credentials: { accessKeyId: 'http-test-only', secretAccessKey: 'http-test-only-secret' },
    maxAttempts: 1,
  });
  config.set('S3_RECORDINGS_BUCKET', 'test-recordings');
  t.mock.method(service.s3, 'send', async (command) => {
    assert.ok(command instanceof HeadObjectCommand);
    commands.push(command.input);
    return { $metadata: { httpStatusCode: 200 } };
  });
  t.after(() => {
    service.s3.destroy();
    service.s3 = originalClient;
    config.set('S3_RECORDINGS_BUCKET', '');
  });
  return { service, commands, config };
}

test('S3 settings and missing files are recording errors while call detail and metadata remain available', async (t) => {
  const { service, config, commands } = playbackStorage(t);
  const row = await call();
  const saved = await recording(row.callSessionSeq);
  config.set('S3_RECORDINGS_BUCKET', '');
  assert.deepEqual((await result(await detail(row.callSessionSeq), false)).data, {
    call: callInfo(row, saved.createdAt),
    analysis: null,
    aiActionCount: 0,
    recordings: [{ ...saved, url: null, expiresAt: null, playbackError: 'DEPENDENCY_UNAVAILABLE' }],
  });
  assert.equal(commands.length, 0);
  config.set('S3_RECORDINGS_BUCKET', 'test-recordings');
  t.mock.method(service.s3, 'send', async () => {
    throw Object.assign(new Error('private missing object'), {
      $metadata: { httpStatusCode: 404 },
    });
  });
  assert.deepEqual((await result(await detail(row.callSessionSeq), false)).data.recordings, [
    { ...saved, url: null, expiresAt: null, playbackError: 'NOT_FOUND' },
  ]);
  assert.equal(
    (await pool.query('SELECT 1 FROM recordings WHERE recording_seq=$1', [saved.recordingSeq]))
      .rowCount,
    1,
  );
});

test('storage denial, outage and timeout preserve call detail with a redacted recording error', async (t) => {
  const { service } = playbackStorage(t);
  const row = await call();
  const saved = await recording(row.callSessionSeq);
  const errors = [403, 500, undefined].map((status) =>
    Object.assign(new Error('private secret object key'), {
      $metadata: { httpStatusCode: status },
    }),
  );
  for (const problem of errors) {
    t.mock.method(service.s3, 'send', async () => {
      throw problem;
    });
    const response = await detail(row.callSessionSeq);
    assert.equal((await response.clone().text()).includes('private secret'), false);
    assert.deepEqual((await result(response, false)).data, {
      call: callInfo(row, saved.createdAt),
      analysis: null,
      aiActionCount: 0,
      recordings: [
        { ...saved, url: null, expiresAt: null, playbackError: 'DEPENDENCY_UNAVAILABLE' },
      ],
    });
  }
});

test('one missing recording does not hide the call or another playable recording', async (t) => {
  const { service } = playbackStorage(t);
  const row = await call();
  const first = await recording(row.callSessionSeq);
  const second = await recording(row.callSessionSeq);
  const missingKey = (
    await pool.query('SELECT object_key FROM recordings WHERE recording_seq=$1', [
      first.recordingSeq,
    ])
  ).rows[0].object_key;
  t.mock.method(service.s3, 'send', async (command) => {
    if (command.input.Key === missingKey)
      throw Object.assign(new Error('private missing object'), {
        $metadata: { httpStatusCode: 404 },
      });
    return { $metadata: { httpStatusCode: 200 } };
  });
  const body = await result(await detail(row.callSessionSeq), false);
  assert.deepEqual(body.data.call, callInfo(row, first.createdAt));
  assert.equal(body.data.analysis, null);
  assert.deepEqual(body.data.recordings[0], {
    ...first,
    url: null,
    expiresAt: null,
    playbackError: 'NOT_FOUND',
  });
  assert.equal(body.data.recordings[1].recordingSeq, second.recordingSeq);
  assert.equal(body.data.recordings[1].playbackError, null);
  assert.ok(body.data.recordings[1].url.startsWith('https://'));
  assert.ok(Date.parse(body.data.recordings[1].expiresAt) > Date.now());
});
