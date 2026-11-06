const customerAddress = require('./helpers/customer-address.cjs');
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, randomInt } = require('node:crypto');
const { ConfigService } = require('@nestjs/config');
const { ConsultationsRepository } = require('../dist/consultations/consultations.repository');
const token = randomBytes(32).toString('hex');
process.env.AI_INSIGHTS_TOKEN = token;
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const f = applicationFixture();
const marker = () => 'private-call-read-' + randomUUID();
const phone = () => '010' + randomInt(10000000, 100000000);
const list = (query = {}, actor = 0, headers = {}) =>
  f.get(
    '/api/calls?' + (typeof query === 'string' ? query : new URLSearchParams(query)),
    actor,
    headers,
  );
const detail = (call, actor = 0, headers = {}) => f.get('/api/calls/' + call.id, actor, headers);
async function ok(response, single = false) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  const body = await response.json();
  assert.deepEqual(
    Object.keys(body).sort(),
    single ? ['data', 'meta'] : ['data', 'hasNext', 'total_count'],
  );
  if (single) assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  return body;
}
const ids = (body) => body.data.map((item) => item.callSessionSeq);
async function createCall(changes = {}) {
  const input = {
    providerCallId: 'rtc_call_read_' + randomUUID(),
    phone: phone(),
    order: null,
    startedAt: '2026-10-31T01:00:03Z',
    endedAt: '2026-10-31T01:03:43Z',
    incomingAt: null,
    ...changes,
  };
  const id = (
    await f.pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,order_seq,started_at,ended_at,incoming_at,customer_seq)
     VALUES($1,$2,$3,$4,$5,$6,(SELECT customer_seq FROM customers WHERE phone_number=$2)) RETURNING call_session_seq`,
      [
        input.providerCallId,
        input.phone,
        input.order,
        input.startedAt,
        input.endedAt,
        input.incomingAt,
      ],
    )
  ).rows[0].call_session_seq;
  return { ...input, id };
}
async function analyse(call, changes = {}) {
  const input = {
    providerCallId: call.providerCallId,
    startedAt: '2026-10-31T10:00:00+09:00',
    endedAt: '2026-10-31T10:03:40+09:00',
    aiPersonaVersionSeq: null,
    repeatQuestionCount: null,
    hasComplaint: null,
    complaints: [],
    ...changes,
  };
  const response = await fetch(f.base + `/api/ai/calls/${call.id}/analysis`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 204, await response.text());
  return input;
}
async function customer(name) {
  const value = { phone: phone(), name };
  value.id = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE') RETURNING customer_seq",
      [name, value.phone],
    )
  ).rows[0].customer_seq;
  return value;
}
async function versions() {
  const persona = (
    await f.pool.query('INSERT INTO ai_personas(code) VALUES($1) RETURNING ai_persona_seq', [
      marker(),
    ])
  ).rows[0].ai_persona_seq;
  const ids = [];
  for (const version of [6, 7])
    ids.push(
      (
        await f.pool.query(
          `INSERT INTO ai_persona_versions(ai_persona_seq,version,prompt_text,name,turn_wait_level,status)
     VALUES($1,$2,'private-call-read-prompt',$3,'NORMAL','INACTIVE') RETURNING ai_persona_version_seq`,
          [persona, version, version === 6 ? '당시 사용한 이름' : '나중에 만든 다른 버전'],
        )
      ).rows[0].ai_persona_version_seq,
    );
  return ids;
}

test('existing call reads require administrator sessions and work for every active role with AI collection disabled', async () => {
  const call = await createCall();
  for (const headers of [{ Cookie: '' }, { Cookie: '', Authorization: 'Bearer ' + token }]) {
    await f.error(await detail(call, 0, headers), 401, 'UNAUTHORIZED');
    await f.error(await list({}, 0, headers), 401, 'UNAUTHORIZED');
  }
  const config = f.app.get(ConfigService);
  config.set('AI_INSIGHTS_TOKEN', '');
  try {
    for (let actor = 0; actor < 3; actor++) {
      const single = (await ok(await detail(call, actor), true)).data;
      assert.equal(single.analysis, null);
      assert.equal(single.call.customerSeq, null);
      assert.equal(single.call.customerName, null);
      assert.equal(Object.hasOwn(single.call, 'analysis'), false);
      const page = await ok(await list({ callerPhoneNumber: call.phone }, actor));
      assert.equal(page.data[0].analysis, null);
    }
  } finally {
    config.set('AI_INSIGHTS_TOKEN', token);
  }
});

test('detail and list expose the stored analysis and actual older persona without changing PBX data or returning hashes and prompts', async () => {
  const used = await versions();
  const order = (await f.pool.query('INSERT INTO orders DEFAULT VALUES RETURNING order_seq'))
    .rows[0].order_seq;
  const call = await createCall({ order });
  const input = await analyse(call, {
    aiPersonaVersionSeq: used[0],
    repeatQuestionCount: 2,
    hasComplaint: true,
    complaints: [
      {
        type: 'REPEATED_QUESTION',
        evidenceText: 'private-call-read-evidence 원문\n 그대로',
        offsetSeconds: 31,
        utteranceOrders: [6, 3],
      },
    ],
  });
  await f.pool.query("UPDATE orders SET status='CANCELLED' WHERE order_seq=$1", [order]);
  const stored = (
    await f.pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [call.id])
  ).rows[0];
  const pbx = (
    await f.pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [call.id])
  ).rows;
  const audits = (await f.pool.query('SELECT count(*) AS n FROM audit_logs')).rows;
  const data = (await ok(await detail(call), true)).data;
  assert.deepEqual(data.analysis, {
    aiPersonaVersionSeq: used[0],
    personaName: '당시 사용한 이름',
    personaVersion: 6,
    isNewCustomer: null,
    registeredParcelCount: null,
    faqAnswerCount: null,
    orderLookupCount: null,
    cancelledParcelCount: null,
    hasHandoffRequest: null,
    hasCallbackRequest: null,
    aiStartedAt: new Date(input.startedAt).toISOString(),
    aiEndedAt: new Date(input.endedAt).toISOString(),
    repeatQuestionCount: 2,
    hasComplaint: true,
    complaints: [{ ...input.complaints[0], utteranceOrders: [3, 6] }],
    analysedAt: stored.analysed_at.toISOString(),
  });
  assert.equal(data.call.startedAt, new Date(call.startedAt).toISOString());
  assert.equal(data.call.endedAt, new Date(call.endedAt).toISOString());
  assert.equal(Object.hasOwn(data.call, 'endReason'), false);
  assert.equal(data.call.orderStatus, 'CANCELLED');
  const page = await ok(await list({ callerPhoneNumber: call.phone }));
  assert.deepEqual(page.data[0].analysis, data.analysis);
  assert.deepEqual(
    (await f.pool.query('SELECT * FROM call_analyses WHERE call_session_seq=$1', [call.id]))
      .rows[0],
    stored,
  );
  assert.deepEqual(
    (await f.pool.query('SELECT * FROM call_sessions WHERE call_session_seq=$1', [call.id])).rows,
    pbx,
  );
  assert.deepEqual((await f.pool.query('SELECT count(*) AS n FROM audit_logs')).rows, audits);
  assert.doesNotMatch(
    JSON.stringify(data),
    /payload_hash|payloadHash|prompt_text|promptText|private-call-read-prompt/,
  );
});

test('list and detail preserve AI summary values including zero, false and unknown without exposing them inside call', async () => {
  for (const values of [
    {
      isNewCustomer: true,
      registeredParcelCount: 3,
      faqAnswerCount: 2,
      orderLookupCount: 1,
      cancelledParcelCount: 1,
      hasHandoffRequest: true,
      hasCallbackRequest: true,
    },
    {
      isNewCustomer: false,
      registeredParcelCount: 0,
      faqAnswerCount: 0,
      orderLookupCount: 0,
      cancelledParcelCount: 0,
      hasHandoffRequest: false,
      hasCallbackRequest: false,
    },
    {
      isNewCustomer: null,
      registeredParcelCount: null,
      faqAnswerCount: null,
      orderLookupCount: null,
      cancelledParcelCount: null,
      hasHandoffRequest: null,
      hasCallbackRequest: null,
    },
  ]) {
    const call = await createCall();
    await analyse(call, values);
    const data = (await ok(await detail(call), true)).data;
    const page = await ok(await list({ callerPhoneNumber: call.phone }));
    assert.deepEqual(page.data[0].analysis, data.analysis);
    for (const [key, value] of Object.entries(values)) {
      assert.equal(data.analysis[key], value);
      assert.equal(Object.hasOwn(data.call, key), false);
      assert.equal(Object.hasOwn(page.data[0], key), false);
    }
    assert.equal(Object.hasOwn(data.call, 'handoff'), false);
    assert.equal(data.call.orderSeq, null);
  }
});

test('complaint and persona filters distinguish missing analysis, unknown measurements, zero and false before pagination', async () => {
  const caller = phone();
  const used = await versions();
  const missing = await createCall({ phone: caller });
  const rows = [];
  for (const hasComplaint of [null, false, true, false, null]) {
    const call = await createCall({ phone: caller });
    await analyse(call, {
      aiPersonaVersionSeq: used[0],
      hasComplaint,
      repeatQuestionCount: hasComplaint === false ? 0 : null,
      complaints: hasComplaint
        ? [
            {
              type: 'SLOW_RESPONSE',
              evidenceText: '느리다고 표현함',
              offsetSeconds: null,
              utteranceOrders: [],
            },
          ]
        : [],
    });
    rows.push({ ...call, hasComplaint });
  }
  assert.deepEqual(
    ids(await ok(await list({ callerPhoneNumber: caller, aiPersonaVersionSeq: used[0] }))),
    rows.toReversed().map((row) => row.id),
  );
  const absent = (await ok(await detail(missing), true)).data;
  assert.equal(absent.analysis, null);
  const unknown = (await ok(await detail(rows[0]), true)).data.analysis;
  assert.equal(unknown.hasComplaint, null);
  assert.equal(unknown.repeatQuestionCount, null);
  const negatives = rows.filter((row) => row.hasComplaint === false).reverse();
  for (const [offset, expected] of negatives.entries()) {
    const page = await ok(
      await list({ callerPhoneNumber: caller, hasComplaint: 'false', limit: '1', offset }),
    );
    assert.deepEqual(ids(page), [expected.id]);
    assert.equal(page.data[0].analysis.hasComplaint, false);
    assert.equal(page.data[0].analysis.repeatQuestionCount, 0);
    assert.equal(page.hasNext, offset < negatives.length - 1);
  }
  assert.deepEqual(ids(await ok(await list({ callerPhoneNumber: caller, hasComplaint: 'true' }))), [
    rows[2].id,
  ]);
  assert.deepEqual(
    ids(await ok(await list({ callerPhoneNumber: caller, aiPersonaVersionSeq: used[1] }))),
    [],
  );
  assert.deepEqual(
    await ok(await list({ callerPhoneNumber: caller, hasComplaint: 'false', offset: '2' })),
    { data: [], hasNext: false, total_count: 2 },
  );
});

test('customer linkage uses order ownership before the caller and follows current names including withdrawn customers', async () => {
  const owner = await customer(marker() + ' 주문 고객');
  const caller = await customer(marker() + ' 발신 고객');
  const order = (
    await f.pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [
      owner.id,
    ])
  ).rows[0].order_seq;
  const ordered = await createCall({ phone: caller.phone, order });
  const inquiry = await createCall({ phone: caller.phone });
  for (const [call, expected] of [
    [ordered, owner],
    [inquiry, caller],
  ]) {
    const data = (await ok(await detail(call), true)).data.call;
    assert.equal(data.customerSeq, expected.id);
    assert.equal(data.customerName, expected.name);
  }
  assert.deepEqual(ids(await ok(await list({ q: owner.name }))), [ordered.id]);
  assert.deepEqual(ids(await ok(await list({ q: caller.name }))), [inquiry.id]);
  const currentName = marker() + ' 현재 이름';
  await f.pool.query("UPDATE customers SET name=$2,status='WITHDRAWN' WHERE customer_seq=$1", [
    owner.id,
    currentName,
  ]);
  assert.deepEqual(ids(await ok(await list({ q: owner.name }))), []);
  const updated = await ok(await list({ q: currentName, callerPhoneNumber: caller.phone }));
  assert.deepEqual(ids(updated), [ordered.id]);
  assert.equal(updated.data[0].customerName, currentName);
  assert.deepEqual(ids(await ok(await list({ q: caller.phone }))), [inquiry.id, ordered.id]);
});

test('inquiries keep the original customer after employee phone updates and never claim a later registrant', async () => {
  const caller = await customer(marker());
  const companyId = (
    await f.pool.query(
      "INSERT INTO organizations(name,status) VALUES($1,'ACTIVE') RETURNING organization_seq",
      [marker()],
    )
  ).rows[0].organization_seq;
  await f.pool.query(
    "INSERT INTO memberships(customer_seq,organization_seq,employee_no,status) VALUES($1,$2,'001','ACTIVE')",
    [caller.id, companyId],
  );
  const start = async (phoneNumber) => {
    const call = { providerCallId: randomUUID(), incomingAt: '2026-10-31T01:00:00Z' };
    const response = await f.write('POST', '/api/customers/context', { phoneNumber, call });
    assert.equal(response.status, 200, await response.clone().text());
    return { ...call, id: (await response.json()).data.callSessionSeq };
  };
  const call = await start(caller.phone);
  const questionText = marker();
  const question = await f.write(
    'POST',
    '/api/ai/unanswered-questions',
    {
      eventId: randomUUID(),
      callSessionSeq: call.id,
      providerCallId: call.providerCallId,
      questionText,
      occurredAt: '2026-10-31T01:01:20Z',
      offsetSeconds: 80,
    },
    0,
    { Cookie: undefined, Authorization: 'Bearer ' + token },
  );
  assert.equal(question.status, 201, await question.clone().text());
  const changed = await f.write('POST', `/api/companies/${companyId}/members`, {
    employeeNo: '001',
    name: caller.name,
    phoneNumber: phone(),
  });
  assert.equal(changed.status, 204, await changed.clone().text());
  const replacement = await f.write('POST', '/api/customers', {
    address: customerAddress(),
    name: marker(),
    phoneNumber: caller.phone,
  });
  assert.equal(replacement.status, 201, await replacement.clone().text());
  const saved = (await ok(await detail(call), true)).data.call;
  assert.equal(saved.customerSeq, caller.id);
  assert.equal(saved.callerPhoneNumber, caller.phone);
  assert.deepEqual(ids(await ok(await list({ q: caller.name }))), [call.id]);
  const questions = await f.get(
    '/api/unanswered-questions?' + new URLSearchParams({ q: questionText }),
  );
  assert.equal(questions.status, 200);
  assert.equal((await questions.json()).data[0].customerSeq, caller.id);

  const unknownPhone = phone();
  const unknown = await start(unknownPhone);
  await analyse(unknown);
  const registeredLater = await f.write('POST', '/api/customers', {
    address: customerAddress(),
    name: marker(),
    phoneNumber: unknownPhone,
  });
  assert.equal(registeredLater.status, 201, await registeredLater.clone().text());
  const inquiry = (await ok(await detail(unknown), true)).data;
  assert.equal(inquiry.call.customerSeq, null);
  assert.equal(inquiry.call.orderSeq, null);
  assert.equal(inquiry.analysis.hasComplaint, null);
  assert.equal(Object.hasOwn(inquiry.analysis, 'result'), false);
  const customerSeq = (await registeredLater.json()).data.customerSeq;
  const context = await f.write(
    'POST',
    '/api/customers/context',
    {
      phoneNumber: unknownPhone,
      call: { providerCallId: unknown.providerCallId, incomingAt: unknown.incomingAt },
    },
    0,
    { Cookie: undefined, ...businessHeaders() },
  );
  assert.equal(context.status, 200);
  // PBX time is separate from the final AI analysis clock.
  await f.pool.query(
    "UPDATE call_sessions SET started_at=incoming_at,ended_at=incoming_at+interval '1 minute' WHERE call_session_seq=$1",
    [unknown.id],
  );
  const finalResult = await f.write(
    'POST',
    '/api/calls/' + unknown.id + '/order-intake/complete',
    { expectedIntakeVersion: 1 },
    0,
    { Cookie: undefined, ...businessHeaders() },
  );
  assert.equal(finalResult.status, 200, await finalResult.clone().text());
  assert.equal((await finalResult.json()).data.status, 'NO_ORDER');
  const linked = (await ok(await detail(unknown), true)).data.call;
  assert.equal(linked.customerSeq, customerSeq);
  assert.equal(linked.orderSeq, null);
});

test('q normalizes Korean and case while treating wildcards and SQL text literally and combining all old filters', async () => {
  const text = marker() + ' 가나다 Mixed%_';
  const owner = await customer(text);
  const order = (
    await f.pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [
      owner.id,
    ])
  ).rows[0].order_seq;
  const call = await createCall({ phone: owner.phone, order });
  await analyse(call, { hasComplaint: false, repeatQuestionCount: 0 });
  const query = {
    q: ('  ' + text.toUpperCase() + '  ').normalize('NFD'),
    orderSeq: order,
    orderStatus: 'COLLECTING',
    callerPhoneNumber: owner.phone,
    hasComplaint: 'false',
    from: '2026-10-31T01:00:03Z',
    to: '2026-10-31T01:00:04Z',
  };
  assert.deepEqual(ids(await ok(await list(query))), [call.id]);
  assert.deepEqual(ids(await ok(await list({ ...query, hasComplaint: 'true' }))), []);
  assert.deepEqual(
    ids(await ok(await list({ ...query, to: query.from, from: '2026-10-31T01:00:02Z' }))),
    [],
  );
  assert.deepEqual(ids(await ok(await list({ callerPhoneNumber: owner.phone, q: '%_' }))), [
    call.id,
  ]);
  assert.deepEqual(
    ids(await ok(await list({ callerPhoneNumber: owner.phone, q: "' OR true --" }))),
    [],
  );
  assert.deepEqual(ids(await ok(await list({ callerPhoneNumber: owner.phone, q: ' \n ' }))), [
    call.id,
  ]);
});

test('new query fields reject ambiguous booleans, malformed versions, duplicates, NUL and long search strings', async () => {
  for (const query of [
    'hasComplaint=',
    'hasComplaint=0',
    'hasComplaint=1',
    'hasComplaint=FALSE',
    'hasComplaint=null',
    'hasComplaint=false&hasComplaint=true',
    'result=',
    'result=UNKNOWN',
    'result=INQUIRY',
    'result=INQUIRY&result=HANDOFF',
    'aiPersonaVersionSeq=0',
    'aiPersonaVersionSeq=1.2',
    'aiPersonaVersionSeq=1e2',
    'aiPersonaVersionSeq=2147483648',
    'aiPersonaVersionSeq=1&aiPersonaVersionSeq=2',
    'q=a&q=b',
    'q=%00',
    'q=' + '가'.repeat(201),
  ])
    await f.error(await list(query), 400, 'INVALID_REQUEST');
});

test('incoming calls are visible in date-filtered lists before analysis, PBX or storage arrives', async () => {
  const call = await createCall({
    startedAt: null,
    endedAt: null,
    incomingAt: '2026-10-31T00:59:58Z',
  });
  const page = await ok(
    await list({
      callerPhoneNumber: call.phone,
      from: call.incomingAt,
      to: '2026-10-31T00:59:59Z',
    }),
  );
  assert.deepEqual(ids(page), [call.id]);
  assert.equal(page.total_count, 1);
  assert.equal(page.data[0].startedAt, '2026-10-31T00:59:58.000Z');
  assert.equal(page.data[0].endedAt, null);
  assert.equal(page.data[0].analysis, null);
  const single = (await ok(await detail(call), true)).data;
  assert.equal(single.call.startedAt, page.data[0].startedAt);
  assert.deepEqual(single.recordings, []);
});

test('AI times update the same call and date filter before PBX or a recording is available', async () => {
  const call = await createCall({
    startedAt: null,
    endedAt: null,
    incomingAt: '2026-10-31T00:59:58Z',
  });
  const input = await analyse(call);
  const query = {
    callerPhoneNumber: call.phone,
    from: input.startedAt,
    to: '2026-10-31T01:00:01Z',
  };
  const page = await ok(await list(query));
  assert.deepEqual(ids(page), [call.id]);
  assert.equal(page.data[0].startedAt, '2026-10-31T01:00:00.000Z');
  assert.equal(page.data[0].endedAt, '2026-10-31T01:03:40.000Z');
  assert.deepEqual(
    ids(await ok(await list({ ...query, from: call.incomingAt, to: input.startedAt }))),
    [],
  );
  const single = (await ok(await detail(call), true)).data;
  assert.equal(single.call.startedAt, page.data[0].startedAt);
  assert.equal(single.call.endedAt, page.data[0].endedAt);
  assert.equal(Object.hasOwn(single.call, 'endReason'), false);
  assert.deepEqual(single.recordings, []);
  const stored = (
    await f.pool.query('SELECT started_at,ended_at FROM call_sessions WHERE call_session_seq=$1', [
      call.id,
    ])
  ).rows[0];
  assert.deepEqual(stored, { started_at: null, ended_at: null });
});

test('late PBX times take priority while the AI analysis and call identity are preserved', async () => {
  const call = await createCall({
    startedAt: null,
    endedAt: null,
    incomingAt: '2026-10-31T00:59:58Z',
  });
  await analyse(call);
  const before = (await ok(await detail(call), true)).data;
  assert.equal(before.call.startedAt, before.analysis.aiStartedAt);
  await f.pool.query(
    'UPDATE call_sessions SET started_at=$2,ended_at=$3 WHERE call_session_seq=$1',
    [call.id, '2026-10-31T01:00:03Z', '2026-10-31T01:03:43Z'],
  );
  const after = (await ok(await detail(call), true)).data;
  assert.equal(after.call.callSessionSeq, before.call.callSessionSeq);
  assert.equal(after.call.startedAt, '2026-10-31T01:00:03.000Z');
  assert.equal(after.call.endedAt, '2026-10-31T01:03:43.000Z');
  assert.deepEqual(after.analysis, before.analysis);
  assert.deepEqual(after.recordings, []);
  assert.deepEqual(
    ids(
      await ok(
        await list({
          callerPhoneNumber: call.phone,
          from: before.call.startedAt,
          to: after.call.startedAt,
        }),
      ),
    ),
    [],
  );
  assert.deepEqual(
    ids(
      await ok(
        await list({
          callerPhoneNumber: call.phone,
          from: after.call.startedAt,
          to: '2026-10-31T01:00:04Z',
        }),
      ),
    ),
    [call.id],
  );
});

test('fallback times share date boundaries, deterministic pagination and analysis filters', async () => {
  const caller = phone();
  const pbx = await createCall({
    phone: caller,
    startedAt: '2026-10-31T02:00:00Z',
    endedAt: '2026-10-31T02:03:00Z',
  });
  const ai = await createCall({ phone: caller, startedAt: null, endedAt: null });
  await analyse(ai, {
    startedAt: '2026-10-31T02:00:00Z',
    endedAt: '2026-10-31T02:03:00Z',
    hasComplaint: false,
  });
  const incoming = await createCall({
    phone: caller,
    startedAt: null,
    endedAt: null,
    incomingAt: '2026-10-31T02:00:00Z',
  });
  await createCall({ phone: caller, startedAt: null, endedAt: null });
  const query = {
    callerPhoneNumber: caller,
    from: '2026-10-31T02:00:00Z',
    to: '2026-10-31T02:00:01Z',
    limit: 1,
  };
  const expected = [incoming.id, ai.id, pbx.id];
  for (const [offset, id] of expected.entries()) {
    const page = await ok(await list({ ...query, offset }));
    assert.deepEqual(ids(page), [id]);
    assert.equal(page.total_count, 3);
    assert.equal(page.hasNext, offset < 2);
  }
  assert.deepEqual(ids(await ok(await list({ ...query, hasComplaint: 'false' }))), [ai.id]);
});

test('late analysis and utterances become readable without inventing a default persona or altering complaint references', async () => {
  const call = await createCall({ startedAt: null, endedAt: null });
  assert.equal((await ok(await detail(call), true)).data.analysis, null);
  const complaint = {
    type: 'AI_REFUSAL',
    evidenceText: '사람과 통화하고 싶다고 표현함',
    offsetSeconds: 0,
    utteranceOrders: [1, 2],
  };
  await analyse(call, { hasComplaint: true, complaints: [complaint] });
  const before = (await ok(await detail(call), true)).data;
  assert.equal(before.call.startedAt, before.analysis.aiStartedAt);
  assert.equal(before.call.endedAt, before.analysis.aiEndedAt);
  assert.equal(before.analysis.aiPersonaVersionSeq, null);
  assert.equal(before.analysis.personaName, null);
  assert.equal(before.analysis.personaVersion, null);
  assert.deepEqual(before.analysis.complaints, [complaint]);
  const events = [1, 2].map((order) => ({
    eventId: randomUUID(),
    eventOrder: order,
    kind: 'UTTERANCE',
    occurredAt: '2026-10-31T10:00:00+09:00',
    offsetSeconds: 0,
    payload: {
      utteranceOrder: order,
      speaker: order === 1 ? 'CUSTOMER' : 'AI',
      utteranceText: marker(),
      lastSentenceSeq: order,
    },
  }));
  const saved = await fetch(f.base + `/api/ai/calls/${call.id}/events`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ providerCallId: call.providerCallId, events }),
  });
  assert.equal(saved.status, 204, await saved.text());
  assert.deepEqual((await ok(await detail(call), true)).data.analysis, before.analysis);
  const transcript = await ok(await f.get(`/api/calls/${call.id}/transcript`));
  assert.deepEqual(
    transcript.data.map((row) => row.utteranceOrder),
    complaint.utteranceOrders,
  );
});

test('read failures remain redacted server errors instead of empty lists or missing analysis', async (t) => {
  const call = await createCall();
  const repository = f.app.get(ConsultationsRepository);
  for (const [method, request] of [
    ['findMany', () => list()],
    ['findOne', () => detail(call)],
  ]) {
    const mock = t.mock.method(repository, method, async () => {
      throw Error('private-call-read-sql SELECT secret');
    });
    try {
      const body = await f.error(await request(), 500, 'INTERNAL_ERROR');
      assert.doesNotMatch(JSON.stringify(body), /private-call-read|SELECT secret/);
    } finally {
      mock.mock.restore();
    }
  }
});

test('OpenAPI documents existing routes with the added filters and nullable shared analysis, and logs redact private inputs', async () => {
  const document = await (await f.get('/api/docs-json')).json();
  const query = document.paths['/api/calls'].get;
  assert.deepEqual(query.security, [{ adminSession: [] }]);
  for (const name of ['q', 'hasComplaint', 'aiPersonaVersionSeq'])
    assert.ok(query.parameters.some((item) => item.name === name));
  assert.equal(
    query.parameters.some((item) => item.name === 'result'),
    false,
  );
  const schemas = document.components.schemas;
  for (const name of ['CallListItemDto', 'CallDetailDto'])
    assert.equal(schemas[name].properties.analysis.nullable, true);
  for (const name of ['customerSeq', 'customerName'])
    assert.equal(schemas.CallDto.properties[name].nullable, true);
  assert.equal(schemas.CallAnalysisDto.properties.hasComplaint.nullable, true);
  assert.equal(schemas.CallAnalysisDto.properties.result, undefined);
  assert.equal(schemas.CallComplaintDto.properties.offsetSeconds.minimum, 0);
  assert.equal(schemas.CallComplaintDto.properties.offsetMs, undefined);
  assert.equal(document.paths['/api/calls/{id}/analysis'], undefined);
  assert.doesNotMatch(JSON.stringify(f.logs), /private-call-read|rtc_call_read_|Bearer /);
});
