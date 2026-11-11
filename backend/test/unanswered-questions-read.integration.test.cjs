require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createTestPool, startTestApp } = require('./helpers/application.cjs');
const { ConfigService } = require('@nestjs/config');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
process.env.SWAGGER_ENABLED = 'false';
const pool = createTestPool();
const apps = [];
const logs = [];
let app, base, cookie, adminId, config, repository;
const rowKeys = [
  'unansweredQuestionSeq',
  'callSessionSeq',
  'callStartedAt',
  'occurredAt',
  'offsetSeconds',
  'customerSeq',
  'customerName',
  'callerPhoneNumber',
  'questionText',
  'reason',
  'status',
  'aiPersonaVersionSeq',
  'faqEntrySeq',
].sort();
const scope = () => 'private-unq-read-' + randomUUID();

async function administrator(role = 'SYSTEM_ADMIN', status = 'ACTIVE') {
  const id = (
    await pool.query(
      'INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,$2,$3,$4,$5) RETURNING admin_user_seq',
      [
        'ur' + randomUUID().replaceAll('-', '').slice(0, 16),
        '조회 관리자',
        'test-only',
        role,
        status,
      ],
    )
  ).rows[0].admin_user_seq;
  const session = randomBytes(32).toString('hex');
  await pool.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)', [
    createHash('sha256').update(session).digest('hex'),
    id,
  ]);
  return { id, cookie: 'dva_session=' + session };
}
async function customer(name) {
  const phone = '010' + randomBytes(4).readUInt32BE().toString().padStart(10, '0');
  const id = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE') RETURNING customer_seq",
      [name, phone],
    )
  ).rows[0].customer_seq;
  return { id, phone, name };
}
async function createCall({
  startedAt = null,
  phone = null,
  orderId = null,
  incomingAt = null,
} = {}) {
  const providerCallId = 'rtc_question_read_' + randomUUID();
  const id = (
    await pool.query(
      'INSERT INTO call_sessions(provider_call_id,caller_phone_number,order_seq,started_at,ended_at,incoming_at,customer_seq) VALUES($1,$2,$3,$4,$5,$6,(SELECT customer_seq FROM customers WHERE phone_number=$2)) RETURNING call_session_seq',
      [
        providerCallId,
        phone,
        orderId,
        startedAt,
        startedAt ? new Date(Date.parse(startedAt) + 180000) : null,
        incomingAt,
      ],
    )
  ).rows[0].call_session_seq;
  return { id, providerCallId };
}
async function question(call, questionText, offsetSeconds = 80, reason = undefined) {
  const response = await fetch(base + '/api/ai/unanswered-questions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId: randomUUID(),
      callSessionSeq: call.id,
      providerCallId: call.providerCallId,
      questionText,
      occurredAt: '2026-10-31T10:01:20+09:00',
      offsetSeconds,
      reason,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).data.unansweredQuestionSeq;
}
async function analyse(call, startedAt, aiPersonaVersionSeq = null) {
  const response = await fetch(base + `/api/ai/calls/${call.id}/analysis`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      providerCallId: call.providerCallId,
      startedAt,
      endedAt: new Date(Date.parse(startedAt) + 180000).toISOString(),
      aiPersonaVersionSeq,
      repeatQuestionCount: null,
      hasComplaint: null,
      complaints: [],
    }),
  });
  assert.equal(response.status, 204, await response.text());
}
const get = (query = {}, headers = {}) =>
  fetch(
    base +
      '/api/unanswered-questions?' +
      (typeof query === 'string' ? query : new URLSearchParams(query)),
    { headers: { Cookie: cookie, ...headers } },
  );
async function list(query = {}, headers = {}) {
  const response = await get(query, headers);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(typeof body.hasNext, 'boolean');
  for (const row of body.data) assert.deepEqual(Object.keys(row).sort(), rowKeys);
  return body;
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  assert.doesNotMatch(
    JSON.stringify(body),
    /private-unq-read-|rtc_question_read_|SELECT |database-password/,
  );
}
const ids = (body) => body.data.map((row) => row.unansweredQuestionSeq);

before(async () => {
  await migrate(pool);
  const {
    UnansweredQuestionsRepository,
  } = require('../dist/unanswered-questions/unanswered-questions.repository');
  app = await startTestApp(apps, { log: (value) => logs.push(value) });
  base = await app.getUrl();
  config = app.get(ConfigService);
  repository = app.get(UnansweredQuestionsRepository);
  ({ id: adminId, cookie } = await administrator());
});
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});

test('list requires an active administrator session, accepts all three roles and ignores AI token availability', async () => {
  for (const headers of [
    { Cookie: '' },
    { Cookie: 'dva_session=bad' },
    { Cookie: '', Authorization: 'Bearer ' + token },
    { Cookie: cookie + '; ' + cookie },
  ])
    await error(await get({}, headers), 401, 'UNAUTHORIZED');
  for (const role of ['OPERATOR', 'SYSTEM_ADMIN']) {
    const actor = await administrator(role);
    await list({ unansweredQuestionSeq: '2147483647' }, { Cookie: actor.cookie });
  }
  for (const status of ['PENDING', 'INACTIVE']) {
    const actor = await administrator('OPERATOR', status);
    await error(await get({}, { Cookie: actor.cookie }), 401, 'UNAUTHORIZED');
  }
  const expired = await administrator();
  await pool.query(
    "UPDATE admin_sessions SET created_at=now()-interval '10 hours',expires_at=now()-interval '1 hour' WHERE admin_user_seq=$1",
    [expired.id],
  );
  await error(await get({}, { Cookie: expired.cookie }), 401, 'UNAUTHORIZED');
  config.set('AI_INSIGHTS_TOKEN', '');
  try {
    await list({ unansweredQuestionSeq: '2147483647' });
  } finally {
    config.set('AI_INSIGHTS_TOKEN', token);
  }
});

test('collected questions return their exact plain text, UTC time and numeric zero, null or safe maximum seconds', async () => {
  const call = await createCall();
  const raw = scope() + ' 질문 원문\n<script>alert("평문")</script> \\ 😊 ';
  for (const offset of [0, null, Number.MAX_SAFE_INTEGER]) {
    const id = await question(call, raw, offset);
    const body = await list({ unansweredQuestionSeq: id });
    assert.deepEqual(body.data, [
      {
        unansweredQuestionSeq: id,
        callSessionSeq: call.id,
        callStartedAt: null,
        occurredAt: '2026-10-31T01:01:20.000Z',
        offsetSeconds: offset,
        customerSeq: null,
        customerName: null,
        callerPhoneNumber: null,
        questionText: raw,
        reason: null,
        status: 'OPEN',
        aiPersonaVersionSeq: null,
        faqEntrySeq: null,
      },
    ]);
    assert.equal(body.hasNext, false);
  }
});

test('OPEN is the default, registered questions have a live FAQ link and deleted rows never return', async () => {
  const call = await createCall();
  const q = scope();
  const open = await question(call, q + ' OPEN');
  const registered = await question(call, q + ' REGISTERED');
  const deleted = await question(call, q + ' DELETED');
  const faq = (
    await pool.query(
      "INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,category) VALUES($1,$2,$3,'기타') RETURNING faq_entry_seq",
      ['조회 fixture 질문', '조회 fixture 답변', adminId],
    )
  ).rows[0].faq_entry_seq;
  await pool.query(
    "UPDATE unanswered_questions SET status='REGISTERED',faq_entry_seq=$2,faq_conversion_hash=$3,registered_at=now() WHERE unanswered_question_seq=$1",
    [registered, faq, 'a'.repeat(64)],
  );
  await pool.query(
    "UPDATE unanswered_questions SET status='DELETED',question_text=NULL,deleted_at=now() WHERE unanswered_question_seq=$1",
    [deleted],
  );
  assert.deepEqual(ids(await list({ q })), [open]);
  assert.deepEqual(ids(await list({ q, status: 'REGISTERED' })), [registered]);
  assert.equal(
    (await list({ unansweredQuestionSeq: registered, status: 'REGISTERED' })).data[0].faqEntrySeq,
    faq,
  );
  await pool.query('DELETE FROM faq_entries WHERE faq_entry_seq=$1', [faq]);
  const row = (await list({ unansweredQuestionSeq: registered, status: 'REGISTERED' })).data[0];
  assert.equal(row.status, 'REGISTERED');
  assert.equal(row.faqEntrySeq, null);
  assert.equal(
    (
      await pool.query(
        'SELECT faq_entry_seq FROM unanswered_questions WHERE unanswered_question_seq=$1',
        [registered],
      )
    ).rows[0].faq_entry_seq,
    faq,
  );
  for (const status of ['OPEN', 'REGISTERED'])
    assert.deepEqual(await list({ unansweredQuestionSeq: deleted, status }), {
      data: [],
      hasNext: false,
      total_count: 0,
    });
});

test('customer resolution prefers the linked order over caller lookup and keeps unlinked or withdrawn history', async () => {
  const owner = await customer(scope() + ' 주문 고객');
  const caller = await customer(scope() + ' 발신 고객');
  const order = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [owner.id])
  ).rows[0].order_seq;
  const ordered = await createCall({ orderId: order, phone: caller.phone });
  const matched = await createCall({ phone: caller.phone });
  const unknown = await createCall({ phone: '02999999999999999' });
  for (const [call, expected] of [
    [ordered, owner],
    [matched, caller],
    [unknown, null],
  ]) {
    const id = await question(call, scope());
    const row = (await list({ unansweredQuestionSeq: id })).data[0];
    assert.equal(row.customerSeq, expected?.id ?? null);
    assert.equal(row.customerName, expected?.name ?? null);
    assert.equal(row.callerPhoneNumber, call === unknown ? '02999999999999999' : caller.phone);
  }
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [owner.id]);
  assert.equal((await list({ callSessionSeq: ordered.id })).data[0].customerSeq, owner.id);
});

test('q searches question, current linked name or caller number and combines other filters with AND', async () => {
  const current = await customer(scope() + ' 고객');
  const call = await createCall({ phone: current.phone });
  const text = scope() + ' 주말 수거 Example';
  const id = await question(call, text);
  for (const q of ['  ' + text + '  ', current.name, current.phone.slice(-8), 'eXAMPLE'])
    assert.deepEqual(ids(await list({ q, callSessionSeq: call.id })), [id]);
  assert.deepEqual(ids(await list({ q: ' \n\t ', callSessionSeq: call.id })), [id]);
  assert.deepEqual(ids(await list({ q: 'no-such-' + randomUUID(), callSessionSeq: call.id })), []);
  const second = await createCall();
  assert.deepEqual(ids(await list({ unansweredQuestionSeq: id, callSessionSeq: second.id })), []);
  const renamed = scope() + ' 새 이름';
  await pool.query('UPDATE customers SET name=$2 WHERE customer_seq=$1', [current.id, renamed]);
  assert.deepEqual(ids(await list({ q: current.name, callSessionSeq: call.id })), []);
  const row = (await list({ q: renamed, callSessionSeq: call.id })).data[0];
  assert.equal(row.customerName, renamed);
  for (const query of [
    { unansweredQuestionSeq: 2147483647 },
    { callSessionSeq: 2147483647 },
    { aiPersonaVersionSeq: 2147483647 },
  ])
    assert.deepEqual(await list(query), { data: [], hasNext: false, total_count: 0 });
});

test('search treats percent, underscore and SQL-like input literally and matches normalized Korean', async () => {
  const call = await createCall();
  const percent = await question(call, scope() + ' 50%');
  const underscore = await question(call, scope() + ' 문구_');
  const injection = await question(call, scope() + " ' OR 1=1 --");
  const korean = await question(call, scope() + ' 가을'.normalize('NFD'));
  for (const [q, id] of [
    ['%', percent],
    ['문구_', underscore],
    ["' OR 1=1 --", injection],
    ['가을', korean],
  ])
    assert.deepEqual(ids(await list({ q, callSessionSeq: call.id })), [id]);
});

test('oldest calls sort first using PBX then AI time, unknown starts sort last and same-call IDs break ties', async () => {
  const q = scope();
  const newer = await createCall({ startedAt: '2026-10-31T03:00:00Z' });
  const older = await createCall({ startedAt: '2026-10-31T01:00:00Z' });
  const unknown = await createCall({ incomingAt: '2026-10-30T00:00:00Z' });
  const ai = await createCall();
  const newId = await question(newer, q);
  const oldId = await question(older, q);
  const unknownId = await question(unknown, q);
  const aiId = await question(ai, q);
  const oldSecond = await question(older, q, 0);
  await analyse(ai, '2026-10-31T02:00:00Z');
  await analyse(newer, '2026-10-30T00:00:00Z');
  const body = await list({ q });
  assert.deepEqual(ids(body), [oldId, oldSecond, aiId, newId, unknownId]);
  assert.deepEqual(
    body.data.map((row) => row.callStartedAt),
    [
      '2026-10-31T01:00:00.000Z',
      '2026-10-31T01:00:00.000Z',
      '2026-10-31T02:00:00.000Z',
      '2026-10-31T03:00:00.000Z',
      null,
    ],
  );
  const range = { q, from: '2026-10-31T10:00:00+09:00', to: '2026-10-31T12:00:00+09:00' };
  assert.deepEqual(ids(await list(range)), [oldId, oldSecond, aiId]);
  assert.deepEqual(
    ids(await list({ ...range, from: '2026-10-31T03:00:00Z', to: '2026-10-31T04:00:00Z' })),
    [newId],
  );
});

test('actual persona version arrives with analysis and never falls back to the current active version', async () => {
  const persona = (
    await pool.query('INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq', [
      'unq-read-' + randomUUID(),
    ])
  ).rows[0].ai_persona_seq;
  const historicalVersion = (
    await pool.query(
      "INSERT INTO ai_persona_versions(ai_persona_seq,version,prompt_text,name,turn_wait_level,status) VALUES($1,1,'fixture','조회 페르소나','NORMAL','INACTIVE') RETURNING ai_persona_version_seq",
      [persona],
    )
  ).rows[0].ai_persona_version_seq;
  const activeVersion =
    (
      await pool.query(
        "SELECT ai_persona_version_seq FROM ai_persona_versions WHERE status='ACTIVE'",
      )
    ).rows[0]?.ai_persona_version_seq ??
    (
      await pool.query(
        `INSERT INTO ai_persona_versions(ai_persona_seq,version,prompt_text,name,turn_wait_level,status,
       application_id,requested_by_admin_user_seq,requested_at,applied_at)
       VALUES($1,2,'fixture','활성 조회 페르소나','NORMAL','ACTIVE',$2,$3,now(),now()) RETURNING ai_persona_version_seq`,
        [persona, randomUUID(), adminId],
      )
    ).rows[0].ai_persona_version_seq;
  const call = await createCall();
  const id = await question(call, scope());
  assert.equal((await list({ unansweredQuestionSeq: id })).data[0].aiPersonaVersionSeq, null);
  assert.deepEqual(
    ids(await list({ unansweredQuestionSeq: id, aiPersonaVersionSeq: activeVersion })),
    [],
  );
  await analyse(call, '2026-10-31T01:00:00Z', historicalVersion);
  assert.deepEqual(
    ids(await list({ unansweredQuestionSeq: id, aiPersonaVersionSeq: historicalVersion })),
    [id],
  );
  assert.deepEqual(
    ids(await list({ unansweredQuestionSeq: id, aiPersonaVersionSeq: activeVersion })),
    [],
  );
  assert.equal(
    (await list({ unansweredQuestionSeq: id })).data[0].callStartedAt,
    '2026-10-31T01:00:00.000Z',
  );
});

test('reason counts combine status, time, call and search filters while excluding deleted or expired history', async () => {
  const q = scope();
  const call = await createCall({ startedAt: '2026-10-31T01:00:00Z' });
  const faq = (
    await pool.query(
      "INSERT INTO faq_entries(question,answer,updated_by_admin_user_seq,category) VALUES($1,'답변',$2,'기타') RETURNING faq_entry_seq",
      [q, adminId],
    )
  ).rows[0].faq_entry_seq;
  const groups = [];
  for (const reason of ['KB_NO_ANSWER', 'KB_UNAVAILABLE', null]) {
    const open = await question(call, q, 0, reason);
    const registered = await question(call, q, null, reason);
    await pool.query(
      "UPDATE unanswered_questions SET status='REGISTERED',faq_entry_seq=$2,faq_conversion_hash=repeat('a',64),registered_at=now() WHERE unanswered_question_seq=$1",
      [registered, faq],
    );
    groups.push({ reason: reason ?? 'UNCLASSIFIED', open, registered });
  }
  const deleted = await question(call, q, 0, 'KB_NO_ANSWER');
  await pool.query(
    "UPDATE unanswered_questions SET status='DELETED',deleted_at=now() WHERE unanswered_question_seq=$1",
    [deleted],
  );
  const hidden = await createCall({ startedAt: '2026-10-31T01:00:00Z' });
  await question(hidden, q, 0, 'KB_NO_ANSWER');
  await pool.query('UPDATE call_sessions SET deleted_at=now() WHERE call_session_seq=$1', [
    hidden.id,
  ]);
  const expired = await createCall({
    startedAt: '2020-01-01T00:00:00Z',
    incomingAt: '2020-01-01T00:00:00Z',
  });
  await pool.query(
    "INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,reason,payload_hash) VALUES($1,$2,$3,'2020-01-01T00:00:01Z','KB_NO_ANSWER',repeat('a',64))",
    [randomUUID(), expired.id, q],
  );
  assert.deepEqual(
    ids(await list({ q })),
    groups.map((group) => group.open),
  );
  assert.deepEqual(
    ids(await list({ q, status: 'REGISTERED' })),
    groups.map((group) => group.registered),
  );
  const all = await list({ q, status: 'ALL' });
  assert.equal(all.total_count, 6);
  assert.equal(all.hasNext, false);
  for (const group of groups) {
    const selected = await list({ q, reason: group.reason, status: 'ALL', limit: 1 });
    assert.deepEqual(ids(selected), [group.open]);
    assert.equal(selected.data[0].reason, group.reason === 'UNCLASSIFIED' ? null : group.reason);
    assert.equal(selected.total_count, 2);
    assert.equal(selected.hasNext, true);
    const next = await list({ q, reason: group.reason, status: 'ALL', limit: 1, offset: 1 });
    assert.deepEqual(ids(next), [group.registered]);
    assert.equal(next.total_count, 2);
    assert.equal(next.hasNext, false);
    assert.deepEqual(await list({ q, reason: group.reason, status: 'ALL', offset: 2 }), {
      data: [],
      hasNext: false,
      total_count: 2,
    });
    assert.equal((await list({ q, reason: group.reason })).total_count, 1);
  }
  assert.equal(
    (
      await list({
        q,
        reason: 'KB_NO_ANSWER',
        status: 'ALL',
        callSessionSeq: call.id,
        from: '2026-10-31T01:00:00Z',
        to: '2026-10-31T01:01:00Z',
      })
    ).total_count,
    2,
  );
  for (const filter of [
    { callSessionSeq: hidden.id },
    { callSessionSeq: expired.id },
    { unansweredQuestionSeq: groups[1].open },
    { from: '2026-10-31T01:01:00Z', to: '2026-11-01T00:00:00Z' },
    { aiPersonaVersionSeq: 2147483647 },
  ])
    assert.equal(
      (await list({ q, reason: 'KB_NO_ANSWER', status: 'ALL', ...filter })).total_count,
      0,
    );
});

test('reads leave question history and audits unchanged; query failures return a redacted 500 and never an empty success', async () => {
  const call = await createCall();
  const id = await question(call, scope());
  const snapshot = async () => ({
    rows: (
      await pool.query('SELECT * FROM unanswered_questions WHERE call_session_seq=$1', [call.id])
    ).rows,
    call: (await pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [call.id]))
      .rows,
    audits: (await pool.query('SELECT count(*) AS n FROM audit_logs')).rows,
  });
  const before = await snapshot();
  await list({ unansweredQuestionSeq: id });
  await list({ callSessionSeq: call.id });
  const original = repository.findMany;
  repository.findMany = async () => {
    throw new Error('SELECT private-unq-read-database-password');
  };
  try {
    await error(await get({ unansweredQuestionSeq: id }), 500, 'INTERNAL_ERROR');
  } finally {
    repository.findMany = original;
  }
  assert.deepEqual(ids(await list({ unansweredQuestionSeq: id })), [id]);
  assert.deepEqual(await snapshot(), before);
  assert.doesNotMatch(
    JSON.stringify(logs),
    /private-unq-read-|rtc_question_read_|database-password/,
  );
});
