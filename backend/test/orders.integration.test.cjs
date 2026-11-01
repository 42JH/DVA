const { testMembership } = require('./helpers/membership.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { migrate } = require('./helpers/migrations.cjs');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { ConfigService } = require('@nestjs/config');
const { createServer } = require('node:http');
const { OrderSubmissionRepository } = require('../dist/orders/order-submission.repository');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const { AuditService } = require('../dist/audit/audit.service');
const { DatabaseService } = require('../dist/database/database.service');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const apps = [],
  hosts = [],
  cookies = [];
const password = 'order-test-only-password';
const origin = 'http://localhost:5173';
let customerId,
  withdrawnId,
  otherId,
  adminId,
  repository,
  organizationId,
  personalPin,
  companyPin,
  otherPin;
let dverServer, dverUrl, dverRespond, submissionRepository;
let dverRequests = [];
const dverSuccess = { ok: true, parcelNo: 'TEST0057', receivedAt: '2026-10-27T10:00:00+09:00' };
const address = {
  name: '검증 고객',
  phoneNumber: '01000000001',
  roadAddress: '검증로 1',
  jibunAddress: '검증동 1',
  detailAddress: '',
  dongName: '검증동',
  postalCode: '00001',
  latitude: 37.5,
  longitude: 127,
};

before(async () => {
  await migrate(pool);
  const hash = await hashPassword(password);
  for (const [index, role] of ['OPERATOR', 'SYSTEM_ADMIN', 'SUPERVISOR'].entries()) {
    const result = await pool.query(
      `INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'주문 검증',$2,$3,'ACTIVE') RETURNING admin_user_seq`,
      [`orderTest${index}`, hash, role],
    );
    if (index === 0) adminId = result.rows[0].admin_user_seq;
    // 두 인스턴스의 동시성 검증은 유지하고 세 번째 역할은 첫 앱에서 인증한다.
    const app = index < 2 ? await NestFactory.create(AppModule, { logger: false }) : apps[0];
    if (index < 2) {
      apps.push(app);
      configureApplication(app, { log: () => {} });
      await app.listen(0, '127.0.0.1');
    }
    hosts.push(await app.getUrl());
    const response = await fetch(hosts[index] + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId: `orderTest${index}`, password }),
    });
    assert.equal(response.status, 200);
    cookies.push(response.headers.get('set-cookie').split(';')[0]);
  }
  repository = apps[0].get(OrdersRepository);
  const customer = async (phone, status) =>
    (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('주문 검증',$1,$2) RETURNING customer_seq",
        [phone, status],
      )
    ).rows[0].customer_seq;
  customerId = await customer('01000000001', 'ACTIVE');
  withdrawnId = await customer('01000000002', 'WITHDRAWN');
  otherId = await customer('01000000003', 'ACTIVE');
  organizationId = (
    await pool.query(
      "INSERT INTO organizations(name,status) VALUES('주문 검증 기업','ACTIVE') RETURNING organization_seq",
    )
  ).rows[0].organization_seq;
  await testMembership(pool, {
    customerSeq: customerId,
    organizationSeq: organizationId,
    employeeNo: 'order-test',
    groupBillingEnabled: true,
  });
  await pool.query(
    'UPDATE customers SET monthly_billing_enabled=true WHERE customer_seq=ANY($1::int[])',
    [[customerId, withdrawnId, otherId]],
  );
  await pool.query(
    'UPDATE organizations SET monthly_billing_enabled=true WHERE organization_seq=$1',
    [organizationId],
  );
  for (const id of [customerId, otherId]) {
    const pin = (
      await pool.query(
        'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
        [id, address],
      )
    ).rows[0].personal_pin_seq;
    if (id === customerId) personalPin = pin;
    else otherPin = pin;
  }
  companyPin = (
    await pool.query(
      'INSERT INTO company_pins(organization_seq,address_data) VALUES($1,$2) RETURNING company_pin_seq',
      [organizationId, address],
    )
  ).rows[0].company_pin_seq;
  dverServer = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    dverRequests.push({ headers: req.headers, body: JSON.parse(body) });
    dverRespond(req, res);
  });
  await new Promise((resolve) => dverServer.listen(0, '127.0.0.1', resolve));
  dverUrl = `http://127.0.0.1:${dverServer.address().port}/parcel`;
  for (const app of apps) {
    app.get(ConfigService).set('DVER_API_URL', dverUrl);
    app.get(ConfigService).set('DVER_API_KEY', 'test-only-dver-key');
  }
  submissionRepository = apps[0].get(OrderSubmissionRepository);
});
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
  dverServer?.closeAllConnections();
  if (dverServer) await new Promise((resolve) => dverServer.close(resolve));
});

const create = (body = { customerSeq: customerId }, key = randomUUID(), index = 0, extra = {}) =>
  fetch(hosts[index] + '/api/orders', {
    method: 'POST',
    headers: Object.fromEntries(
      Object.entries({
        Origin: origin,
        Cookie: cookies[index],
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
        ...extra,
      }).filter(([, v]) => v !== undefined),
    ),
    body: JSON.stringify(body),
  });
const counts = async () =>
  (
    await pool.query(`SELECT
  (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_parcels) AS parcels,
  (SELECT count(*) FROM orders WHERE creation_request_id IS NOT NULL) AS creationKeys,
  (SELECT count(*) FROM customers) AS customers,
  (SELECT count(*) FROM shipments) AS shipments`)
  ).rows[0];
const errorCode = async (response, status, code) => {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
};

const call = async (phone = null, ended = false) =>
  (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,started_at,ended_at)
   VALUES($1,$2,$3,$4) RETURNING call_session_seq`,
      [
        randomUUID(),
        phone,
        ended ? '2026-10-27T00:00:00Z' : null,
        ended ? '2026-10-27T00:01:00Z' : null,
      ],
    )
  ).rows[0].call_session_seq;
const aiCreate = (callId, body, key = randomUUID(), index = 0, extra = {}) =>
  create(body, key, index, {
    Cookie: undefined,
    Origin: undefined,
    call_session_seq: callId === undefined ? undefined : String(callId),
    ...extra,
  });

test('AI uses the same ORD-01 for partial and complete data, with one linked order and no shipment', async () => {
  for (const parcels of [
    [{ origin: { name: '수집 중' } }],
    [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }],
  ]) {
    const callId = await call('01000000001');
    const response = await aiCreate(callId, {
      customerSeq: customerId,
      pickupRequestedAt: '2026-10-28T10:00:00+09:00',
      parcels,
    });
    assert.equal(response.status, 201);
    const { data } = await response.json();
    const stored = (
      await pool.query(
        'SELECT o.status,o.customer_seq,o.version,c.order_seq FROM orders o JOIN call_sessions c ON c.order_seq=o.order_seq WHERE c.call_session_seq=$1',
        [callId],
      )
    ).rows[0];
    assert.deepEqual(stored, {
      status: 'COLLECTING',
      customer_seq: customerId,
      version: data.version,
      order_seq: data.orderSeq,
    });
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1',
          [data.orderSeq],
        )
      ).rows[0].count,
      '0',
    );
    const audit = (
      await pool.query(
        "SELECT actor_seq FROM audit_logs WHERE action='ORDER_CREATED' AND target_seq=$1 AND result='SUCCESS'",
        [data.orderSeq],
      )
    ).rows;
    assert.deepEqual(audit, [{ actor_seq: null }]);
  }
});

test('AI requires a real open call and never trusts arbitrary customer or administrator headers', async () => {
  const before = await counts(),
    body = { customerSeq: customerId };
  for (const id of [undefined, 0, 'bad', '1.5', 2147483648])
    await errorCode(await aiCreate(id, body), 400, 'INVALID_REQUEST');
  await errorCode(await aiCreate(2147483647, body), 404, 'NOT_FOUND');
  await errorCode(await aiCreate(await call(null, true), body), 409, 'INVALID_STATE');
  await errorCode(
    await aiCreate(await call('01099999999'), body, randomUUID(), 0, {
      'X-Admin-User-Seq': String(adminId),
    }),
    403,
    'FORBIDDEN',
  );
  assert.deepEqual(await counts(), before);
});

test('call replay returns the first response after termination; a new key cannot create another order', async () => {
  const callId = await call(),
    key = randomUUID(),
    body = { customerSeq: customerId };
  const first = await aiCreate(callId, body, key);
  assert.equal(first.status, 201);
  const { data } = await first.json();
  await pool.query(
    "UPDATE call_sessions SET started_at='2026-10-27T00:00:00Z',ended_at='2026-10-27T00:01:00Z' WHERE call_session_seq=$1",
    [callId],
  );
  const replay = await aiCreate(callId, body, key, 1);
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, data);
  await errorCode(await aiCreate(callId, body), 409, 'INVALID_STATE');
  const unchanged = await aiCreate(callId, { ...body, paymentMethodType: 'billing' }, key);
  assert.equal(unchanged.status, 201);
  assert.deepEqual((await unchanged.json()).data, data);
  assert.equal(
    (await pool.query('SELECT payment_method_type FROM orders WHERE order_seq=$1', [data.orderSeq]))
      .rows[0].payment_method_type,
    null,
  );
  assert.equal(
    (await pool.query('SELECT status FROM orders WHERE order_seq=$1', [data.orderSeq])).rows[0]
      .status,
    'COLLECTING',
  );
});

test('concurrent AI retries across application instances create one order per call', async () => {
  const callId = await call(),
    key = randomUUID(),
    body = { customerSeq: customerId };
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) => aiCreate(callId, body, key, i % 2)),
  );
  const ids = [];
  for (const response of responses) {
    assert.ok([201, 409].includes(response.status));
    if (response.status === 201) ids.push((await response.json()).data.orderSeq);
    else assert.equal((await response.json()).error.code, 'REQUEST_IN_PROGRESS');
  }
  assert.ok(ids.length > 0);
  assert.equal(new Set(ids).size, 1);
  assert.equal((await (await aiCreate(callId, body, key)).json()).data.orderSeq, ids[0]);
  const secondCall = await call();
  const differentKeys = await Promise.all([
    aiCreate(secondCall, body),
    aiCreate(secondCall, body, randomUUID(), 1),
  ]);
  assert.deepEqual(differentKeys.map((r) => r.status).sort(), [201, 409]);
});

test('AI call linkage, new customer, order and creation key roll back together on audit failure', async () => {
  const callId = await call('01000559999'),
    key = randomUUID();
  const body = { customer: { name: 'AI 신규 고객', phoneNumber: '01000559999' }, parcels: [{}] };
  const audit = apps[0].get(AuditService),
    original = audit.recordSuccess,
    before = await counts();
  audit.recordSuccess = async (event, client) => {
    if (event.action === 'ORDER_CREATED') throw Error('rollback-test');
    return original.call(audit, event, client);
  };
  try {
    assert.equal((await aiCreate(callId, body, key)).status, 500);
    assert.deepEqual(await counts(), before);
    assert.equal(
      (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
        .rows[0].order_seq,
      null,
    );
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal((await aiCreate(callId, body, key)).status, 201);
});

test('administrator cookies require current sessions and Origin without falling back to AI', async () => {
  const before = await counts();
  for (const Cookie of ['dva_session=bad', 'dva_session=' + 'f'.repeat(64)]) {
    await errorCode(
      await create(undefined, undefined, 0, {
        Cookie,
        Authorization: 'Bearer fake-ai-token',
        'X-Admin-User-Seq': String(adminId),
      }),
      401,
      'UNAUTHORIZED',
    );
  }
  for (const Origin of [undefined, 'https://untrusted.invalid'])
    await errorCode(await create(undefined, undefined, 0, { Origin }), 403, 'FORBIDDEN');
  await pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [adminId]);
  try {
    await errorCode(await create(), 401, 'UNAUTHORIZED');
  } finally {
    await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [adminId]);
  }
  assert.deepEqual(await counts(), before);
});

test('all active administrator roles create COLLECTING orders with defaults and no shipments', async () => {
  const before = await counts();
  for (let index = 0; index < 3; index++) {
    const response = await create(undefined, undefined, index);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { data, meta } = await response.json();
    assert.deepEqual(Object.keys(data).sort(), ['orderSeq', 'version']);
    assert.equal(meta.requestId, response.headers.get('x-request-id'));
    const row = (
      await pool.query(
        'SELECT customer_seq,payment_method_type,pickup_requested_at,status,version,parcel_no,dver_received_at FROM orders WHERE order_seq=$1',
        [data.orderSeq],
      )
    ).rows[0];
    assert.deepEqual(row, {
      customer_seq: customerId,
      payment_method_type: null,
      pickup_requested_at: null,
      status: 'COLLECTING',
      version: 1,
      parcel_no: null,
      dver_received_at: null,
    });
    assert.equal(data.version, row.version);
  }
  assert.equal((await counts()).shipments, before.shipments);
});

const emptyAiResult = (changes = {}) => ({
  outcome: 'INCOMPLETE',
  call: {
    providerCallId: randomUUID(),
    callerPhoneNumber: '01000000001',
    incomingAt: '2026-10-27T01:00:00Z',
  },
  customerSeq: customerId,
  ...changes,
});

test('an empty AI result preserves its call without creating an order, payment or Dver submission', async () => {
  resetDver();
  const before = await counts();
  const input = emptyAiResult();
  const key = randomUUID();
  const response = await aiCreate(undefined, input, key);
  assert.equal(response.status, 201);
  const saved = (await response.json()).data;
  assert.equal(saved.status, 'NO_ORDER');
  assert.equal(saved.orderSeq, null);
  assert.equal(saved.version, null);
  assert.equal(saved.paymentRequest, null);
  assert.equal(saved.totalAmount, null);
  assert.ok(saved.callSessionSeq > 0);
  const session = (
    await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [
      saved.callSessionSeq,
    ])
  ).rows[0];
  assert.equal(session.order_seq, null);
  const replay = await aiCreate(undefined, input, key, 1);
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, saved);
  assert.deepEqual(await counts(), before);
  assert.equal(dverRequests.length, 0);
});

test('empty incomplete and cancelled snapshots ignore blank parcels and preserve all existing orders', async () => {
  const before = await counts();
  for (const outcome of ['INCOMPLETE', 'CANCELLED']) {
    for (const parcels of [
      undefined,
      [],
      [{}],
      [
        {
          origin: { name: null, detailAddress: ' ' },
          destination: {},
          smallBoxCount: 0,
          itemPrice: null,
          notifiedPrice: null,
        },
      ],
    ]) {
      const response = await aiCreate(undefined, emptyAiResult({ outcome, parcels }));
      assert.equal(response.status, 201);
      const result = (await response.json()).data;
      assert.equal(result.status, 'NO_ORDER');
      assert.equal(result.orderSeq, null);
    }
  }
  assert.deepEqual(await counts(), before);
});

test('partly collected AI orders are retained without assigning an unspecified payment method', async () => {
  resetDver();
  for (const change of [
    { parcels: [{ destination: { name: '수령인만 수집' } }] },
    { parcels: [{ smallBoxCount: 1 }] },
    { parcels: [{ itemPrice: 0 }] },
    { paymentMethodType: 'billing' },
    { pickupRequestedAt: '2026-12-01T00:00:00Z' },
  ]) {
    const response = await aiCreate(undefined, emptyAiResult(change));
    assert.equal(response.status, 201);
    const saved = (await response.json()).data;
    assert.equal(saved.status, 'COLLECTING');
    assert.ok(saved.orderSeq > 0);
    const detail = (await (await readDetail(saved.orderSeq)).json()).data;
    assert.equal(detail.paymentMethodType, change.paymentMethodType ?? null);
    assert.equal(saved.paymentRequest, null);
  }
  assert.equal(dverRequests.length, 0);
});

test('empty AI results keep replay identity after call termination and reject key or call reuse', async () => {
  const input = emptyAiResult(),
    key = randomUUID();
  const saved = (await (await aiCreate(undefined, input, key)).json()).data;
  const before = await counts();
  await pool.query(
    "UPDATE call_sessions SET started_at=incoming_at,ended_at=incoming_at+interval '1 minute' WHERE call_session_seq=$1",
    [saved.callSessionSeq],
  );
  const replay = await aiCreate(undefined, { ...input, paymentMethodType: 'billing' }, key, 1);
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, saved);
  await errorCode(await aiCreate(undefined, emptyAiResult(), key), 403, 'FORBIDDEN');
  await errorCode(await create({ customerSeq: customerId }, key), 403, 'FORBIDDEN');
  await errorCode(await aiCreate(undefined, input), 409, 'INVALID_STATE');
  assert.deepEqual(await counts(), before);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM empty_ai_order_results WHERE call_session_seq=$1', [
        saved.callSessionSeq,
      ])
    ).rowCount,
    1,
  );
});

test('concurrent empty and collected AI results serialize by request key and call identity', async () => {
  for (const sameKey of [true, false]) {
    const input = emptyAiResult(),
      key = randomUUID(),
      before = await counts();
    const responses = await Promise.all([
      aiCreate(undefined, input, key),
      aiCreate(undefined, input, sameKey ? key : randomUUID(), 1),
    ]);
    assert.ok(responses.some((response) => response.status === 201));
    for (const response of responses) {
      assert.ok([201, 409].includes(response.status));
      if (response.status === 201) assert.equal((await response.json()).data.status, 'NO_ORDER');
    }
    const session = (
      await pool.query(
        'SELECT call_session_seq,order_seq FROM call_sessions WHERE provider_call_id=$1',
        [input.call.providerCallId],
      )
    ).rows;
    assert.equal(session.length, 1);
    assert.equal(session[0].order_seq, null);
    assert.equal(
      (
        await pool.query('SELECT 1 FROM empty_ai_order_results WHERE call_session_seq=$1', [
          session[0].call_session_seq,
        ])
      ).rowCount,
      1,
    );
    assert.deepEqual(await counts(), before);
  }
  const input = emptyAiResult();
  const responses = await Promise.all([
    aiCreate(undefined, input),
    aiCreate(undefined, { ...input, parcels: [{ smallBoxCount: 1 }] }, randomUUID(), 1),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const saved = (await (await responses.find((response) => response.status === 201)).json()).data;
  const session = (
    await pool.query('SELECT order_seq FROM call_sessions WHERE provider_call_id=$1', [
      input.call.providerCallId,
    ])
  ).rows[0];
  assert.equal(session.order_seq, saved.orderSeq);
});

test('order-free calls still accept AI events and analysis and remain visible to administrators', async () => {
  const input = emptyAiResult();
  const result = (await (await aiCreate(undefined, input)).json()).data;
  const config = apps[0].get(ConfigService),
    previous = config.get('AI_INSIGHTS_TOKEN');
  const token = 'test-only-empty-order-insights-token';
  config.set('AI_INSIGHTS_TOKEN', token);
  const post = (path, body) =>
    fetch(hosts[0] + `/api/ai/calls/${result.callSessionSeq}/${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    const events = await post('events', {
      providerCallId: input.call.providerCallId,
      events: [
        {
          eventId: randomUUID(),
          eventOrder: 1,
          kind: 'AI_ACTION',
          occurredAt: input.call.incomingAt,
          offsetSeconds: 0,
          payload: {
            action: 'ORDER_SUBMITTED',
            orderSeq: null,
            summaryText: '주문 없는 통화 결과 수신',
          },
        },
      ],
    });
    assert.equal(events.status, 204, await events.text());
    const analysis = await post('analysis', {
      providerCallId: input.call.providerCallId,
      startedAt: input.call.incomingAt,
      endedAt: '2026-10-27T01:01:00Z',
      aiPersonaVersionSeq: null,
      result: 'INQUIRY',
      repeatQuestionCount: 0,
      hasComplaint: false,
      complaints: [],
    });
    assert.equal(analysis.status, 204, await analysis.text());
    const response = await fetch(hosts[0] + `/api/calls/${result.callSessionSeq}`, {
      headers: { Cookie: cookies[0] },
    });
    assert.equal(response.status, 200);
    const detail = (await response.json()).data;
    assert.equal(detail.call.orderSeq, null);
    assert.equal(detail.analysis.result, 'INQUIRY');
    assert.equal(detail.aiActionCount, 1);
  } finally {
    config.set('AI_INSIGHTS_TOKEN', previous);
  }
});

test('a failed empty-result receipt rolls back the new call and can be retried safely', async () => {
  const input = emptyAiResult(),
    key = randomUUID(),
    before = await counts();
  const save = repository.saveEmptyResult;
  repository.saveEmptyResult = async () => {
    throw Error('test-only-receipt-failure');
  };
  try {
    assert.equal((await aiCreate(undefined, input, key)).status, 500);
  } finally {
    repository.saveEmptyResult = save;
  }
  assert.deepEqual(await counts(), before);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM call_sessions WHERE provider_call_id=$1', [
        input.call.providerCallId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT 1 FROM empty_ai_order_results WHERE request_id=$1', [key])).rowCount,
    0,
  );
  const replay = await aiCreate(undefined, input, key);
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).data.status, 'NO_ORDER');
});

test('complete AI results must select a payment method before anything is persisted', async () => {
  resetDver();
  const before = await counts();
  const input = aiResult('COMPLETE', { paymentMethodType: undefined });
  const response = await aiCreate(undefined, input);
  assert.equal(response.status, 422);
  const problem = await response.json();
  assert.ok(
    problem.error.details.some(
      (entry) => entry.field === 'paymentMethodType' && entry.reason === 'required',
    ),
  );
  assert.deepEqual(await counts(), before);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM call_sessions WHERE provider_call_id=$1', [
        input.call.providerCallId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(dverRequests.length, 0);
});

test('migration 037 preserves legacy choices and only permits undecided drafts or cancellations', async () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      "CREATE TEMP TABLE orders(order_seq integer GENERATED ALWAYS AS IDENTITY, payment_method_type text NOT NULL DEFAULT 'billing', status text NOT NULL DEFAULT 'COLLECTING')",
    );
    await client.query(
      "INSERT INTO orders(payment_method_type) VALUES('billing'),('credit'),('groupBilling'),('cat')",
    );
    const before = (await client.query('SELECT * FROM orders ORDER BY order_seq')).rows;
    await client.query(
      readFileSync(join(__dirname, '../migrations/037-undecided-order-payment-method.sql'), 'utf8'),
    );
    assert.deepEqual((await client.query('SELECT * FROM orders ORDER BY order_seq')).rows, before);
    const created = (
      await client.query('INSERT INTO orders DEFAULT VALUES RETURNING payment_method_type')
    ).rows[0];
    assert.equal(created.payment_method_type, null);
    await client.query("INSERT INTO orders(status) VALUES('CANCELLED')");
    for (const status of ['notPaid', 'PAID', 'SUBMITTING', 'ACCEPTED', 'SUBMISSION_FAILED']) {
      await client.query('SAVEPOINT payment_check');
      await assert.rejects(client.query('INSERT INTO orders(status) VALUES($1)', [status]), {
        code: '23514',
        constraint: 'orders_payment_method_required_check',
      });
      await client.query('ROLLBACK TO SAVEPOINT payment_check');
    }
    assert.equal(
      (
        await client.query(
          "SELECT attnotnull FROM pg_attribute WHERE attrelid='pg_temp.orders'::regclass AND attname='payment_method_type'",
        )
      ).rows[0].attnotnull,
      false,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const order = (
    await pool.query(
      'INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq,payment_method_type',
      [customerId],
    )
  ).rows[0];
  assert.equal(order.payment_method_type, null);
  await assert.rejects(
    pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.order_seq]),
    { code: '23514', constraint: 'orders_payment_method_required_check' },
  );
});

test('partial parcel snapshots retain field mapping, defaults and the actual trigger-updated version', async () => {
  const response = await create({
    customerSeq: customerId,
    paymentMethodType: 'billing',
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    parcels: [
      {
        origin: address,
        destination: { name: '수령인', latitude: 0, longitude: 0 },
        originPin: { scope: 'PERSONAL', pinSeq: personalPin },
        documentCount: 2,
        itemPrice: 123,
        clientComment: "' ; SELECT 1; --",
      },
      { origin: { name: '둘째' }, smallBoxCount: 1 },
    ],
  });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  const rows = (
    await pool.query('SELECT * FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position', [
      data.orderSeq,
    ])
  ).rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].origin_phone_number, address.phoneNumber);
  assert.equal(rows[0].origin_road_address, address.roadAddress);
  assert.equal(rows[0].origin_postal_code, address.postalCode);
  assert.equal(rows[0].origin_latitude, address.latitude);
  assert.equal(rows[0].destination_name, '수령인');
  assert.equal(rows[0].destination_latitude, 0);
  assert.equal(rows[0].destination_phone_number, null);
  assert.equal(rows[0].origin_pin_seq, personalPin);
  assert.equal(rows[0].document_count, 2);
  assert.equal(rows[0].item_price, '123');
  assert.equal(rows[0].client_comment, "' ; SELECT 1; --");
  assert.equal(rows[1].parcel_position, 2);
  assert.equal(rows[1].document_count, 0);
  assert.equal(rows[1].item_price, null);
  assert.ok(rows.every((row) => row.notified_price === null));
  const header = (
    await pool.query('SELECT version,pickup_requested_at FROM orders WHERE order_seq=$1', [
      data.orderSeq,
    ])
  ).rows[0];
  assert.equal(header.pickup_requested_at.toISOString(), '2026-10-28T01:00:00.000Z');
  assert.equal(data.version, header.version);
  assert.equal(data.version, 3);
});

test('2500 details use bounded bulk inserts, preserve trigger versions and roll back earlier batches on failure', async () => {
  const database = apps[0].get(DatabaseService),
    transaction = database.transaction;
  let writes = 0,
    failAt = 0;
  database.transaction = (work) =>
    transaction.call(database, async (client) => {
      const query = client.query;
      client.query = async function (sql, ...args) {
        const result = await query.call(this, sql, ...args);
        if (/^\s*INSERT INTO order_parcels\b/.test(sql)) {
          writes++;
          assert.equal(args[0].length, 1);
          if (writes === failAt) throw Error('bulk-parcel-rollback');
        }
        return result;
      };
      try {
        return await work(client);
      } finally {
        client.query = query;
      }
    });
  const input = {
    customerSeq: customerId,
    parcels: Array.from({ length: 2500 }, () => ({ smallBoxCount: 1 })),
  };
  try {
    const response = await create(input);
    assert.equal(response.status, 201, await response.clone().text());
    const result = (await response.json()).data;
    assert.equal(writes, 13);
    const stored = (
      await pool.query(
        'SELECT count(*)::int AS count,min(parcel_position) AS first,max(parcel_position) AS last,sum(small_box_count)::int AS boxes FROM order_parcels WHERE order_seq=$1',
        [result.orderSeq],
      )
    ).rows[0];
    assert.deepEqual(stored, { count: 2500, first: 1, last: 2500, boxes: 2500 });
    assert.equal(result.version, 2501);
    const before = await counts();
    writes = 0;
    failAt = 2;
    await errorCode(await create(input), 500, 'INTERNAL_ERROR');
    assert.deepEqual(await counts(), before);
  } finally {
    database.transaction = transaction;
  }
});

test('invalid bodies and keys fail before order writes', async () => {
  const before = await counts();
  for (const body of [
    { customerSeq: '1' },
    { customerSeq: customerId, parcels: [{ origin: { extra: 1 } }] },
    { customerSeq: customerId, parcels: [{ notifiedPrice: 0 }] },
  ])
    await errorCode(await create(body), 400, 'INVALID_REQUEST');
  for (const key of ['bad', ''])
    await errorCode(await create(undefined, key), 400, 'INVALID_REQUEST');
  await errorCode(
    await create(undefined, undefined, 0, { 'Idempotency-Key': undefined }),
    400,
    'INVALID_REQUEST',
  );
  await errorCode(await create({ customerSeq: 2147483647 }), 404, 'NOT_FOUND');
  await errorCode(await create({ customerSeq: withdrawnId }), 403, 'FORBIDDEN');
  assert.deepEqual(await counts(), before);
});

test('PIN access is checked for the order customer and active company membership', async () => {
  const body = (scope, pinSeq) => ({
    customerSeq: customerId,
    parcels: [{ originPin: { scope, pinSeq } }],
  });
  for (const pin of [otherPin, 2147483647])
    await errorCode(await create(body('PERSONAL', pin)), 403, 'FORBIDDEN');
  assert.equal((await create(body('COMPANY', companyPin))).status, 201);
  await pool.query("UPDATE memberships SET status='INACTIVE' WHERE customer_seq=$1", [customerId]);
  try {
    await errorCode(await create(body('COMPANY', companyPin)), 403, 'FORBIDDEN');
  } finally {
    await pool.query("UPDATE memberships SET status='ACTIVE' WHERE customer_seq=$1", [customerId]);
  }
  await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [
    organizationId,
  ]);
  try {
    await errorCode(await create(body('COMPANY', companyPin)), 403, 'FORBIDDEN');
  } finally {
    await pool.query("UPDATE organizations SET status='ACTIVE' WHERE organization_seq=$1", [
      organizationId,
    ]);
  }
});

test('creation key returns the current order version without applying a second body or accepting another actor', async () => {
  const key = randomUUID(),
    requestId = randomUUID();
  const first = await create({ customerSeq: customerId }, key, 0, { 'X-Request-Id': requestId });
  assert.equal(first.status, 201);
  const { data } = await first.json();
  await pool.query("UPDATE orders SET payment_method_type='cat' WHERE order_seq=$1", [
    data.orderSeq,
  ]);
  const current = (
    await pool.query('SELECT version,creation_request_id FROM orders WHERE order_seq=$1', [
      data.orderSeq,
    ])
  ).rows[0];
  assert.equal(current.creation_request_id, key);
  const replay = await create(
    { customerSeq: customerId, paymentMethodType: 'groupBilling' },
    key.toUpperCase(),
  );
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, {
    orderSeq: data.orderSeq,
    version: current.version,
  });
  assert.ok(current.version > data.version);
  assert.equal(
    (await pool.query('SELECT payment_method_type FROM orders WHERE order_seq=$1', [data.orderSeq]))
      .rows[0].payment_method_type,
    'cat',
  );
  const logs = (
    await pool.query(
      "SELECT actor_seq,request_id,metadata FROM audit_logs WHERE action='ORDER_CREATED' AND target_seq=$1 AND result='SUCCESS'",
      [data.orderSeq],
    )
  ).rows;
  assert.deepEqual(logs, [{ actor_seq: adminId, request_id: requestId, metadata: {} }]);
  await errorCode(await create({ customerSeq: customerId }, key, 1), 403, 'FORBIDDEN');
  await errorCode(await aiCreate(await call(), { customerSeq: customerId }, key), 403, 'FORBIDDEN');
  await assert.rejects(
    pool.query('INSERT INTO orders(creation_request_id) VALUES($1)', [key]),
    (error) => error.code === '23505',
  );
});

test('AI replay stays bound to the original call even after restart and order changes', async () => {
  const callId = await call(),
    key = randomUUID(),
    body = { customerSeq: customerId };
  const first = await aiCreate(callId, body, key);
  assert.equal(first.status, 201);
  const { orderSeq } = (await first.json()).data;
  await pool.query("UPDATE orders SET payment_method_type='cat' WHERE order_seq=$1", [orderSeq]);
  await errorCode(await aiCreate(await call(), body, key), 403, 'FORBIDDEN');
  await errorCode(await create(body, key), 403, 'FORBIDDEN');
  const restarted = await NestFactory.create(AppModule, { logger: false });
  apps.push(restarted);
  configureApplication(restarted, { log: () => {} });
  await restarted.listen(0, '127.0.0.1');
  const retry = await fetch((await restarted.getUrl()) + '/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
      call_session_seq: String(callId),
    },
    body: JSON.stringify(body),
  });
  assert.equal(retry.status, 201);
  const version = (await pool.query('SELECT version FROM orders WHERE order_seq=$1', [orderSeq]))
    .rows[0].version;
  assert.deepEqual((await retry.json()).data, { orderSeq, version });
});

test('in-flight duplicates across application instances return 409 and retry the stored result', async () => {
  const key = randomUUID(),
    client = await pool.connect();
  await client.query('BEGIN');
  try {
    assert.equal(await repository.lockCreation(client, key), true);
    await errorCode(await create(undefined, key), 409, 'REQUEST_IN_PROGRESS');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const cookieB = cookies[1];
  cookies[1] = cookies[0];
  try {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, i) => create(undefined, key, i % 2)),
    );
    const ids = [];
    for (const response of responses) {
      assert.ok([201, 409].includes(response.status));
      if (response.status === 201) ids.push((await response.json()).data.orderSeq);
      else assert.equal((await response.json()).error.code, 'REQUEST_IN_PROGRESS');
    }
    assert.ok(ids.length > 0);
    assert.equal(new Set(ids).size, 1);
    const retry = await create(undefined, key, 1);
    assert.equal(retry.status, 201);
    assert.equal((await retry.json()).data.orderSeq, ids[0]);
    assert.equal(
      (await pool.query('SELECT count(*) FROM orders WHERE creation_request_id=$1', [key])).rows[0]
        .count,
      '1',
    );
  } finally {
    cookies[1] = cookieB;
  }
});

test('creation key and success-audit failures roll back header, parcels and creation key while preserving safe failure audit', async () => {
  const audit = apps[0].get(AuditService);
  for (const [target, method] of [
    [repository, 'insert'],
    [audit, 'recordSuccess'],
  ]) {
    const original = target[method],
      before = await counts(),
      requestId = randomUUID(),
      key = randomUUID();
    target[method] = async function (...args) {
      if (method === 'insert') await original.apply(this, args);
      throw new Error('private-order-diagnostic');
    };
    try {
      const response = await create(
        { customerSeq: customerId, parcels: [{ origin: { name: '비공개이름' } }] },
        key,
        0,
        { 'X-Request-Id': requestId },
      );
      assert.equal(response.status, 500);
      assert.ok(!(await response.text()).includes('private-order-diagnostic'));
      assert.deepEqual(await counts(), before);
      const logs = (
        await pool.query('SELECT result,metadata FROM audit_logs WHERE request_id=$1', [requestId])
      ).rows;
      assert.deepEqual(logs, [{ result: 'FAILED', metadata: {} }]);
    } finally {
      target[method] = original;
    }
    assert.equal(
      (
        await create(
          { customerSeq: customerId, parcels: [{ origin: { name: '비공개이름' } }] },
          key,
        )
      ).status,
      201,
    );
  }
});

test('new customer and draft order are saved together, with one customer audit and a creation key', async () => {
  const key = randomUUID(),
    requestId = randomUUID();
  const input = { customer: { name: '신규 주문 고객', phoneNumber: '01000550001' }, parcels: [{}] };
  const before = await counts();
  const response = await create(input, key, 0, { 'X-Request-Id': requestId });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  const customer = (
    await pool.query(
      'SELECT c.customer_seq,c.name,c.phone_number,c.status FROM customers c JOIN orders o USING(customer_seq) WHERE o.order_seq=$1',
      [data.orderSeq],
    )
  ).rows[0];
  assert.equal(customer.name, input.customer.name);
  assert.equal(customer.phone_number, input.customer.phoneNumber);
  assert.equal(customer.status, 'ACTIVE');
  assert.equal(Number((await counts()).customers), Number(before.customers) + 1);
  const replay = await create(
    {
      customer: { phoneNumber: input.customer.phoneNumber, name: input.customer.name },
      parcels: [{}],
      paymentMethodType: 'credit',
    },
    key,
  );
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, data);
  const afterReplay = await counts();
  assert.equal(Number(afterReplay.orders), Number(before.orders) + 1);
  assert.equal(Number(afterReplay.customers), Number(before.customers) + 1);
  for (const changed of [
    { ...input.customer, name: '다른 이름' },
    { ...input.customer, phoneNumber: '01000550002' },
  ])
    assert.deepEqual(
      (await (await create({ ...input, customer: changed }, key)).json()).data,
      data,
    );
  assert.deepEqual(await counts(), afterReplay);
  const logs = (
    await pool.query(
      'SELECT action,target_type,target_seq,actor_seq,result,metadata FROM audit_logs WHERE request_id=$1 ORDER BY action',
      [requestId],
    )
  ).rows;
  assert.deepEqual(logs, [
    {
      action: 'CUSTOMER_CREATED',
      target_type: 'CUSTOMER',
      target_seq: customer.customer_seq,
      actor_seq: adminId,
      result: 'SUCCESS',
      metadata: {},
    },
    {
      action: 'ORDER_CREATED',
      target_type: 'ORDER',
      target_seq: data.orderSeq,
      actor_seq: adminId,
      result: 'SUCCESS',
      metadata: {},
    },
  ]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM audit_logs WHERE target_type='CUSTOMER' AND target_seq=$1 AND action='CUSTOMER_CREATED'",
        [customer.customer_seq],
      )
    ).rows[0].count,
    '1',
  );
});

test('existing phone links the same customer without overwriting identity, status or PIN scope', async () => {
  const input = {
    customer: { name: '기존 이름 덮어쓰기 시도', phoneNumber: '01000000001' },
    parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: personalPin } }],
  };
  const before = await counts(),
    requestId = randomUUID();
  const response = await create(input, randomUUID(), 0, { 'X-Request-Id': requestId });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal(
    (await pool.query('SELECT customer_seq FROM orders WHERE order_seq=$1', [data.orderSeq]))
      .rows[0].customer_seq,
    customerId,
  );
  assert.deepEqual(
    (await pool.query('SELECT name,status FROM customers WHERE customer_seq=$1', [customerId]))
      .rows[0],
    { name: '주문 검증', status: 'ACTIVE' },
  );
  assert.equal((await counts()).customers, before.customers);
  assert.deepEqual(
    (await pool.query('SELECT action FROM audit_logs WHERE request_id=$1', [requestId])).rows,
    [{ action: 'ORDER_CREATED' }],
  );
  await errorCode(
    await create({ ...input, parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: otherPin } }] }),
    403,
    'FORBIDDEN',
  );
  await errorCode(
    await create({ customer: { name: '탈퇴 복원 시도', phoneNumber: '01000000002' } }),
    403,
    'FORBIDDEN',
  );
  assert.equal(
    (await pool.query('SELECT status FROM customers WHERE customer_seq=$1', [withdrawnId])).rows[0]
      .status,
    'WITHDRAWN',
  );
});

test('invalid or ambiguous customer references never create customer or order rows', async () => {
  const before = await counts();
  for (const body of [
    {},
    { customerSeq: customerId, customer: { name: '신규', phoneNumber: '01000550100' } },
    { customerSeq: null, customer: { name: '신규', phoneNumber: '01000550100' } },
    { customer: null },
    { customer: { name: ' ', phoneNumber: '01000550100' } },
    { customer: { name: '신규', phoneNumber: '010-0055-0100' } },
    { customer: { name: '신규', phoneNumber: '01000550100', status: 'ACTIVE' } },
  ])
    await errorCode(await create(body), 400, 'INVALID_REQUEST');
  await errorCode(
    await create({ customer: { name: '신규', phoneNumber: '01000550100' } }, randomUUID(), 0, {
      Cookie: undefined,
    }),
    400,
    'INVALID_REQUEST',
  );
  assert.deepEqual(await counts(), before);
});

test('concurrent distinct orders across instances share a single newly registered phone identity', async () => {
  const customer = { name: '동시 주문 고객', phoneNumber: '01000550003' };
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) => create({ customer }, randomUUID(), i % 2)),
  );
  const ids = [];
  for (const response of responses) {
    assert.equal(response.status, 201);
    ids.push((await response.json()).data.orderSeq);
  }
  assert.equal(new Set(ids).size, 6);
  const rows = (
    await pool.query('SELECT customer_seq,name FROM customers WHERE phone_number=$1', [
      customer.phoneNumber,
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, customer.name);
  const linked = (
    await pool.query('SELECT DISTINCT customer_seq FROM orders WHERE order_seq=ANY($1::int[])', [
      ids,
    ])
  ).rows;
  assert.deepEqual(linked, [{ customer_seq: rows[0].customer_seq }]);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM audit_logs WHERE action='CUSTOMER_CREATED' AND target_seq=$1",
        [rows[0].customer_seq],
      )
    ).rows[0].count,
    '1',
  );
});

test('PIN denial, creation key failure and order-audit failure roll back newly registered customers too', async () => {
  const deniedBefore = await counts();
  await errorCode(
    await create({
      customer: { name: '거절된 신규', phoneNumber: '01000550004' },
      parcels: [{ originPin: { scope: 'PERSONAL', pinSeq: personalPin } }],
    }),
    403,
    'FORBIDDEN',
  );
  assert.deepEqual(await counts(), deniedBefore);
  const audit = apps[0].get(AuditService);
  for (const [index, [target, method]] of [
    [repository, 'insert'],
    [audit, 'recordSuccess'],
  ].entries()) {
    const original = target[method],
      before = await counts(),
      requestId = randomUUID(),
      key = randomUUID();
    const input = {
      customer: { name: '롤백 고객', phoneNumber: `0100055001${index}` },
      parcels: [{}],
    };
    target[method] = async function (...args) {
      if (method === 'recordSuccess' && args[0].action !== 'ORDER_CREATED')
        return original.apply(this, args);
      if (method === 'insert') await original.apply(this, args);
      throw new Error('private-customer-order-diagnostic');
    };
    try {
      const response = await create(input, key, 0, { 'X-Request-Id': requestId });
      assert.equal(response.status, 500);
      assert.ok(!(await response.text()).includes('private-customer-order-diagnostic'));
      assert.deepEqual(await counts(), before);
      assert.deepEqual(
        (
          await pool.query('SELECT result,metadata FROM audit_logs WHERE request_id=$1', [
            requestId,
          ])
        ).rows,
        [{ result: 'FAILED', metadata: {} }],
      );
    } finally {
      target[method] = original;
    }
    assert.equal((await create(input, key)).status, 201);
    assert.equal(Number((await counts()).customers), Number(before.customers) + 1);
  }
});

test('a fully populated new-customer order remains COLLECTING until a separate final submission', async () => {
  const before = await counts();
  const response = await create({
    customer: { name: '정보 완성 고객', phoneNumber: '01000550020' },
    pickupRequestedAt: '2026-10-28T10:00:00+09:00',
    paymentMethodType: 'billing',
    parcels: [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }],
  });
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.deepEqual(
    (
      await pool.query('SELECT status,parcel_no,dver_received_at FROM orders WHERE order_seq=$1', [
        data.orderSeq,
      ])
    ).rows[0],
    { status: 'COLLECTING', parcel_no: null, dver_received_at: null },
  );
  assert.equal((await counts()).shipments, before.shipments);
});

let readPhone = 580000;
const readCustomer = async () => {
  const phone = '010' + String(++readPhone).padStart(8, '0');
  const customer = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status,monthly_billing_enabled) VALUES('조회 고객',$1,'ACTIVE',true) RETURNING customer_seq",
      [phone],
    )
  ).rows[0].customer_seq;
  return { customer, phone };
};
const readOrder = async (customer, parcels = []) => {
  const response = await create({ customerSeq: customer, paymentMethodType: 'billing', parcels });
  assert.equal(response.status, 201);
  return (await response.json()).data.orderSeq;
};
const readOrders = (query = '', extra = {}, index = 0) =>
  fetch(hosts[index] + '/api/orders' + query, {
    headers: Object.fromEntries(
      Object.entries({ Cookie: cookies[index], ...extra }).filter(([, v]) => v !== undefined),
    ),
  });
const aiReadHeaders = (callId) => ({ Cookie: undefined, call_session_seq: String(callId) });

test('ORD-02 paginates orders once each, including zero-detail drafts and equal creation times', async () => {
  const { customer } = await readCustomer();
  const ids = [];
  for (let i = 0; i < 3; i++)
    ids.push(
      await readOrder(
        customer,
        Array.from({ length: i }, () => ({})),
      ),
    );
  await pool.query("UPDATE orders SET created_at='2026-10-27T01:00:00Z' WHERE customer_seq=$1", [
    customer,
  ]);
  const first = await readOrders(`?customerSeq=${customer}&limit=2`);
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(body.hasNext, true);
  assert.deepEqual(
    body.data.map((o) => o.orderSeq),
    [ids[2], ids[1]],
  );
  assert.deepEqual(
    body.data.map((o) => o.parcelCount),
    [2, 1],
  );
  assert.equal(Object.hasOwn(body.data[0], 'shipmentStatuses'), false);
  assert.equal(body.data[0].pickupRequestedAt, null);
  assert.equal(body.data[0].status, 'COLLECTING');
  const last = await (await readOrders(`?customerSeq=${customer}&limit=2&offset=2`)).json();
  assert.equal(last.hasNext, false);
  assert.deepEqual(
    last.data.map((o) => o.orderSeq),
    [ids[0]],
  );
  assert.equal(last.data[0].parcelCount, 0);
  assert.deepEqual(await (await readOrders(`?customerSeq=${customer}&offset=3`)).json(), {
    data: [],
    hasNext: false,
    total_count: 3,
  });
});

test('ORD-02 combines filters, keeps date boundaries and aggregates all parcels without duplicates', async () => {
  const { customer } = await readCustomer();
  const selected = await readOrder(customer, [
    { destination: { name: 'Alice_100%' } },
    { destination: { name: '다른 수령인' } },
    { destination: { name: 'Alice_100%' } },
  ]);
  const end = await readOrder(customer, [{ destination: { name: 'Alice_100%' } }]);
  await pool.query(
    "UPDATE orders SET created_at='2026-10-27T00:00:00Z',pickup_requested_at='2026-10-28T00:00:00Z',status='ACCEPTED',parcel_no='READ0058',dver_received_at='2026-10-27T01:00:00Z' WHERE order_seq=$1",
    [selected],
  );
  await pool.query("UPDATE orders SET created_at='2026-10-28T00:00:00Z' WHERE order_seq=$1", [end]);
  const parcels = (
    await pool.query(
      'SELECT order_parcel_seq FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position',
      [selected],
    )
  ).rows;
  for (const [i, p] of parcels.entries())
    await pool.query(
      'INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES($1,$2,$3)',
      [p.order_parcel_seq, randomUUID(), ['paid', 'sent', 'paid'][i]],
    );
  const filters = new URLSearchParams({
    customerSeq: customer,
    from: '2026-10-27T09:00:00+09:00',
    to: '2026-10-28T00:00:00Z',
    status: 'ACCEPTED',
    recipientName: 'alice_100%',
  });
  const response = await readOrders('?' + filters);
  assert.equal(response.status, 200);
  const { data, hasNext } = await response.json();
  assert.equal(hasNext, false);
  assert.equal(data.length, 1);
  assert.equal(data[0].orderSeq, selected);
  assert.equal(data[0].parcelCount, 3);
  assert.equal(data[0].status, 'ACCEPTED');
  assert.equal(Object.hasOwn(data[0], 'shipmentStatuses'), false);
  const range = await (
    await readOrders(`?customerSeq=${customer}&from=2026-10-27T00:00:00Z&to=2026-10-28T00:00:00Z`)
  ).json();
  assert.deepEqual(
    range.data.map((o) => o.orderSeq),
    [selected],
  );
  for (const text of ['%', '_', "' OR 1=1 --"]) {
    const result = await (
      await readOrders(`?customerSeq=${customer}&recipientName=${encodeURIComponent(text)}`)
    ).json();
    assert.equal(result.data.length, text.includes('OR') ? 0 : 2);
  }
  assert.deepEqual(
    (await (await readOrders(`?customerSeq=${customer}&status=CANCELLED`)).json()).data,
    [],
  );
});

test('order list filters every order status independently of shipment state', async () => {
  const { customer } = await readCustomer();
  const statuses = [
    'COLLECTING',
    'notPaid',
    'PAID',
    'SUBMITTING',
    'ACCEPTED',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ];
  const orders = new Map();
  for (const status of statuses) {
    const id = await readOrder(customer);
    await pool.query(
      `UPDATE orders SET status=$2,pickup_requested_at='2026-10-28T00:00:00Z',
       parcel_no=CASE WHEN $2='ACCEPTED' THEN 'READ0058' END,
       dver_received_at=CASE WHEN $2='ACCEPTED' THEN '2026-10-27T00:00:00Z'::timestamptz END
       WHERE order_seq=$1`,
      [id, status],
    );
    orders.set(status, id);
  }
  for (const status of statuses) {
    const response = await readOrders(`?customerSeq=${customer}&status=${status}`);
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(
      data.map((order) => [order.orderSeq, order.status]),
      [[orders.get(status), status]],
    );
    assert.equal(Object.hasOwn(data[0], 'shipmentStatuses'), false);
  }
});

test('ORD-02 AI scope comes from the active call customer, never arbitrary customer filters', async () => {
  const { customer, phone } = await readCustomer();
  const own = await readOrder(customer);
  await readOrder(otherId);
  const callId = await call(phone);
  const result = await readOrders('', aiReadHeaders(callId));
  assert.equal(result.status, 200);
  assert.deepEqual(
    (await result.json()).data.map((o) => o.orderSeq),
    [own],
  );
  assert.equal((await readOrders(`?customerSeq=${customer}`, aiReadHeaders(callId))).status, 200);
  await errorCode(
    await readOrders(`?customerSeq=${otherId}`, aiReadHeaders(callId)),
    403,
    'FORBIDDEN',
  );
  await errorCode(await readOrders('', aiReadHeaders(await call())), 403, 'FORBIDDEN');
  await errorCode(await readOrders('', aiReadHeaders(await call('01099999999'))), 403, 'FORBIDDEN');
  await errorCode(
    await readOrders('', aiReadHeaders(await call(phone, true))),
    409,
    'INVALID_STATE',
  );
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [customer]);
  await errorCode(await readOrders('', aiReadHeaders(callId)), 403, 'FORBIDDEN');
  // The same organization does not grant access to another customer's orders.
  const organizationCall = await call('01000000003');
  await testMembership(pool, {
    customerSeq: otherId,
    organizationSeq: organizationId,
    employeeNo: 'read-other',
  });
  await errorCode(
    await readOrders(`?customerSeq=${customerId}`, aiReadHeaders(organizationCall)),
    403,
    'FORBIDDEN',
  );
});

test('ORD-02 validates filters and call IDs while preserving administrator authentication', async () => {
  for (const query of [
    '?from=2026-10-28T00:00:00Z&to=2026-10-27T00:00:00Z',
    '?from=2026-10-27T00:00:00Z&to=2026-10-27T00:00:00Z',
    '?from=2026-10-27T00:00:00+99:00',
    '?customerSeq=1&customerSeq=2',
    '?limit=101',
    '?offset=-1',
    '?status=unknown',
    '?shipmentStatus=sent',
    '?recipientName=',
    '?unknown=1',
  ])
    await errorCode(await readOrders(query), 400, 'INVALID_REQUEST');
  for (const callId of [undefined, '', 'abc', '0', '-1', '2147483648', '1,2']) {
    await errorCode(
      await readOrders('', { Cookie: undefined, call_session_seq: callId }),
      400,
      'INVALID_REQUEST',
    );
  }
  await errorCode(await readOrders('', aiReadHeaders(2147483647)), 404, 'NOT_FOUND');
  const callId = await call('01000000001');
  await errorCode(
    await readOrders('', { ...aiReadHeaders(callId), Cookie: 'dva_session=expired' }),
    401,
    'UNAUTHORIZED',
  );
  for (let i = 0; i < 3; i++) assert.equal((await readOrders('', {}, i)).status, 200);
});

const readDetail = (id, extra = {}, index = 0) =>
  fetch(hosts[index] + '/api/orders/' + id, {
    headers: Object.fromEntries(
      Object.entries({ Cookie: cookies[index], ...extra }).filter(([, v]) => v !== undefined),
    ),
  });

test('ORD-03 returns draft details, every nullable address field and the actual version without writes', async () => {
  const { customer } = await readCustomer();
  const id = await readOrder(customer, [
    { origin: { name: '수집한 이름', phoneNumber: '01000000001', latitude: 0 }, itemPrice: 0 },
    { destination: address, itemPrice: Number.MAX_SAFE_INTEGER, documentCount: 2 },
    {},
  ]);
  const before = (
    await pool.query('SELECT version,updated_at FROM orders WHERE order_seq=$1', [id])
  ).rows[0];
  const response = await readDetail(id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.meta.requestId, /^[0-9a-f-]{36}$/);
  const order = body.data;
  assert.equal(order.orderSeq, id);
  assert.equal(order.customerSeq, customer);
  assert.equal(order.status, 'COLLECTING');
  assert.equal(order.version, before.version);
  assert.equal(Date.parse(order.updatedAt), before.updated_at.getTime());
  assert.equal(order.parcelNo, null);
  assert.equal(order.dverReceivedAt, null);
  assert.equal(order.pickupRequestedAt, null);
  assert.deepEqual(
    order.parcels.map((p) => p.parcelPosition),
    [1, 2, 3],
  );
  const emptyAddress = Object.fromEntries(Object.keys(address).map((key) => [key, null]));
  assert.deepEqual(order.parcels[0].origin, {
    ...emptyAddress,
    name: '수집한 이름',
    phoneNumber: '01000000001',
    latitude: 0,
  });
  assert.deepEqual(order.parcels[0].destination, emptyAddress);
  assert.deepEqual(order.parcels[1].destination, address);
  assert.equal(order.parcels[0].itemPrice, 0);
  assert.equal(order.parcels[1].itemPrice, Number.MAX_SAFE_INTEGER);
  assert.equal(order.parcels[2].itemPrice, null);
  for (const parcel of order.parcels) {
    assert.equal(parcel.orderSeq, id);
    assert.ok(Number.isInteger(parcel.orderParcelSeq));
    assert.equal(parcel.originPin, null);
    assert.equal(Object.hasOwn(parcel, 'shipment'), false);
    assert.equal(parcel.notifiedPrice, null);
  }
  assert.equal(order.creationRequestId, undefined);
  assert.equal(order.deliverySyncStatus, undefined);
  assert.equal(order.parcelCount, undefined);
  assert.equal(order.shipmentStatuses, undefined);
  assert.deepEqual(
    (await pool.query('SELECT version,updated_at FROM orders WHERE order_seq=$1', [id])).rows[0],
    before,
  );
  const empty = await readOrder(customer);
  assert.deepEqual((await (await readDetail(empty)).json()).data.parcels, []);
});

test('order detail returns order snapshots and status without exposing stored shipment data', async () => {
  const { customer } = await readCustomer();
  const pin = (
    await pool.query(
      'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
      [customer, address],
    )
  ).rows[0].personal_pin_seq;
  const id = await readOrder(customer, [
    {
      origin: address,
      originPin: { scope: 'PERSONAL', pinSeq: pin },
      destination: address,
      smallBoxCount: 1,
      itemPrice: 0,
    },
    { destination: { name: '두 번째 수령인' } },
  ]);
  await pool.query('UPDATE personal_pins SET address_data=$2 WHERE personal_pin_seq=$1', [
    pin,
    { ...address, roadAddress: '변경된 원본 주소' },
  ]);
  const parcel = (
    await pool.query(
      'SELECT order_parcel_seq FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position LIMIT 1',
      [id],
    )
  ).rows[0].order_parcel_seq;
  await pool.query(
    "UPDATE orders SET status='ACCEPTED',pickup_requested_at='2026-10-28T00:00:00Z',parcel_no='READ0058',dver_received_at='2026-10-27T00:00:00Z' WHERE order_seq=$1",
    [id],
  );
  const trackingNumber = randomUUID();
  await pool.query(
    "INSERT INTO shipments(order_parcel_seq,tracking_number,status,version,status_changed_at) VALUES($1,$2,'sent',3,'2026-10-27T01:00:00Z')",
    [parcel, trackingNumber],
  );
  const storedShipment = (
    await pool.query('SELECT * FROM shipments WHERE order_parcel_seq=$1', [parcel])
  ).rows[0];
  const order = (await (await readDetail(id)).json()).data;
  assert.equal(order.status, 'ACCEPTED');
  assert.equal(order.parcelNo, 'READ0058');
  assert.equal(Date.parse(order.dverReceivedAt), Date.parse('2026-10-27T00:00:00Z'));
  assert.deepEqual(order.parcels[0].origin, address);
  assert.deepEqual(order.parcels[0].originPin, { scope: 'PERSONAL', pinSeq: pin });
  assert.deepEqual(order.parcels[0].destination, address);
  assert.equal(order.parcels[0].smallBoxCount, 1);
  assert.equal(order.parcels[0].itemPrice, 0);
  for (const parcel of order.parcels) {
    assert.equal(Object.hasOwn(parcel, 'shipment'), false);
    assert.equal(Object.hasOwn(parcel, 'trackingNumber'), false);
    assert.equal(parcel.status, 'ACTIVE');
    assert.equal(Object.hasOwn(parcel, 'shipmentStatus'), false);
  }
  assert.equal(JSON.stringify(order).includes(trackingNumber), false);
  assert.deepEqual(
    (await pool.query('SELECT * FROM shipments WHERE order_parcel_seq=$1', [parcel])).rows[0],
    storedShipment,
  );
  for (let i = 0; i < 3; i++) assert.equal((await readDetail(id, {}, i)).status, 200);
});

test('ORD-03 scopes AI detail reads to the call customer and hides other or missing orders equally', async () => {
  const { customer, phone } = await readCustomer();
  const own = await readOrder(customer),
    other = await readOrder(otherId);
  const callId = await call(phone);
  assert.equal((await readDetail(own, aiReadHeaders(callId))).status, 200);
  const forbidden = await readDetail(other, aiReadHeaders(callId));
  const missing = await readDetail(2147483647, aiReadHeaders(callId));
  assert.equal(forbidden.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual((await forbidden.json()).error, (await missing.json()).error);
  await errorCode(await readDetail(own, aiReadHeaders(await call())), 403, 'FORBIDDEN');
  await errorCode(
    await readDetail(own, aiReadHeaders(await call(phone, true))),
    409,
    'INVALID_STATE',
  );
  await errorCode(
    await readDetail(own, { ...aiReadHeaders(callId), Cookie: 'dva_session=expired' }),
    401,
    'UNAUTHORIZED',
  );
  await errorCode(await readDetail(own, { Cookie: undefined }), 400, 'INVALID_REQUEST');
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [customer]);
  await errorCode(await readDetail(own, aiReadHeaders(callId)), 403, 'FORBIDDEN');
  assert.equal((await readDetail(own)).status, 200);
  for (const bad of ['0', '-1', '2147483648', '1.5', '1e2', 'abc'])
    await errorCode(await readDetail(bad), 400, 'INVALID_REQUEST');
});

test('ORD-03 keeps order version and parcels in one snapshot during a concurrent edit', async () => {
  const { customer, phone } = await readCustomer();
  const id = await readOrder(customer, [{ origin: { name: '변경 전' } }]);
  const callId = await call(phone);
  const before = (await pool.query('SELECT version FROM orders WHERE order_seq=$1', [id])).rows[0]
    .version;
  const original = repository.detail;
  repository.detail = async function (...args) {
    await pool.query("UPDATE order_parcels SET origin_name='변경 후' WHERE order_seq=$1", [id]);
    return original.apply(this, args);
  };
  try {
    const response = await readDetail(id, aiReadHeaders(callId));
    assert.equal(response.status, 200);
    const order = (await response.json()).data;
    assert.equal(order.version, before);
    assert.equal(order.parcels[0].origin.name, '변경 전');
  } finally {
    repository.detail = original;
  }
  const after = (await (await readDetail(id)).json()).data;
  assert.ok(after.version > before);
  assert.equal(after.parcels[0].origin.name, '변경 후');
});

const patchOrder = (id, input, extra = {}, index = 0) =>
  fetch(hosts[index] + '/api/orders/' + id, {
    method: 'PATCH',
    headers: Object.fromEntries(
      Object.entries({
        Origin: origin,
        Cookie: cookies[index],
        'Content-Type': 'application/json',
        ...extra,
      }).filter(([, value]) => value !== undefined),
    ),
    body: JSON.stringify(input),
  });
const storedOrder = async (id) => {
  const response = await readDetail(id);
  assert.equal(response.status, 200);
  return (await response.json()).data;
};

test('ORD-04 merges addresses, preserves omitted parcels and appends after the largest position', async () => {
  const id = await readOrder(customerId, [
    {
      origin: address,
      destination: address,
      originPin: { scope: 'PERSONAL', pinSeq: personalPin },
      documentCount: 2,
      smallBoxCount: 3,
      itemPrice: 4000,
      clientComment: '유지',
    },
    { destination: { name: '변경하지 않을 상세' } },
  ]);
  await pool.query(
    'UPDATE order_parcels SET parcel_position=5 WHERE order_seq=$1 AND parcel_position=2',
    [id],
  );
  const before = await storedOrder(id);
  const requestId = randomUUID();
  const response = await patchOrder(
    id,
    {
      expectedVersion: before.version,
      paymentMethodType: 'billing',
      pickupRequestedAt: '2026-10-28T10:00:00+09:00',
      parcels: [
        {
          orderParcelSeq: before.parcels[0].orderParcelSeq,
          destination: { roadAddress: "배송로 '); DROP TABLE orders; --", detailAddress: null },
          origin: { latitude: 0 },
          documentCount: 0,
        },
        {
          destination: { name: '새 상세', phoneNumber: '0012345' },
          smallBoxCount: 1,
          itemPrice: Number.MAX_SAFE_INTEGER,
        },
      ],
    },
    { 'X-Request-Id': requestId },
  );
  assert.equal(response.status, 200);
  const result = await response.json(),
    after = await storedOrder(id);
  assert.deepEqual(result, { data: { version: after.version }, meta: { requestId } });
  assert.ok(after.version > before.version);
  assert.equal(after.paymentMethodType, 'billing');
  assert.equal(Date.parse(after.pickupRequestedAt), Date.parse('2026-10-28T01:00:00Z'));
  assert.deepEqual(after.parcels[0], {
    ...before.parcels[0],
    documentCount: 0,
    origin: { ...before.parcels[0].origin, latitude: 0 },
    destination: {
      ...before.parcels[0].destination,
      roadAddress: "배송로 '); DROP TABLE orders; --",
      detailAddress: null,
    },
  });
  assert.deepEqual(after.parcels[1], before.parcels[1]);
  const added = after.parcels[2];
  assert.equal(added.parcelPosition, 6);
  assert.equal(added.destination.phoneNumber, '0012345');
  assert.equal(added.origin.name, null);
  assert.equal(added.originPin, null);
  assert.equal(added.documentCount, 0);
  assert.equal(added.clientComment, '');
  assert.equal(added.notifiedPrice, null);
  assert.equal(added.itemPrice, Number.MAX_SAFE_INTEGER);
  assert.equal(Object.hasOwn(added, 'shipment'), false);
  assert.equal(after.parcelNo, null);
  assert.equal(after.dverReceivedAt, null);
  assert.equal(after.status, 'COLLECTING');
  assert.deepEqual(
    (
      await pool.query('SELECT address_data FROM personal_pins WHERE personal_pin_seq=$1', [
        personalPin,
      ])
    ).rows[0].address_data,
    address,
  );
  assert.deepEqual(
    (
      await pool.query(
        "SELECT actor_seq,metadata FROM audit_logs WHERE action='ORDER_UPDATED' AND request_id=$1 AND result='SUCCESS'",
        [requestId],
      )
    ).rows,
    [{ actor_seq: adminId, metadata: {} }],
  );
});

test('ORD-04 clears nullable values and preserves zero or empty text without resetting omitted data', async () => {
  const id = await readOrder(customerId, [
    {
      origin: address,
      destination: address,
      originPin: { scope: 'PERSONAL', pinSeq: personalPin },
      itemPrice: 100,
      smallBoxCount: 2,
      clientComment: '이전',
    },
  ]);
  await pool.query(
    "UPDATE orders SET pickup_requested_at='2026-10-28T00:00:00Z' WHERE order_seq=$1",
    [id],
  );
  const before = await storedOrder(id);
  const emptyAddress = Object.fromEntries(Object.keys(address).map((key) => [key, null]));
  assert.equal(
    (
      await patchOrder(id, {
        expectedVersion: before.version,
        pickupRequestedAt: null,
        parcels: [
          {
            orderParcelSeq: before.parcels[0].orderParcelSeq,
            origin: emptyAddress,
            originPin: null,
            itemPrice: null,
            smallBoxCount: 0,
            clientComment: '',
          },
        ],
      })
    ).status,
    200,
  );
  const after = await storedOrder(id);
  assert.equal(after.pickupRequestedAt, null);
  assert.deepEqual(after.parcels[0].origin, emptyAddress);
  assert.deepEqual(after.parcels[0].destination, before.parcels[0].destination);
  assert.equal(after.parcels[0].originPin, null);
  assert.equal(after.parcels[0].itemPrice, null);
  assert.equal(after.parcels[0].smallBoxCount, 0);
  assert.equal(after.parcels[0].clientComment, '');
});

test('ORD-04 consumes the version even for an unchanged value and rejects replay', async () => {
  const { customer } = await readCustomer();
  const id = await readOrder(customer),
    before = await storedOrder(id);
  const input = { expectedVersion: before.version, paymentMethodType: before.paymentMethodType };
  const response = await patchOrder(id, input);
  assert.equal(response.status, 200);
  const after = await storedOrder(id);
  assert.equal((await response.json()).data.version, after.version);
  assert.ok(after.version > before.version);
  await errorCode(await patchOrder(id, input), 409, 'VERSION_CONFLICT');
  assert.deepEqual(await storedOrder(id), after);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
        [id],
      )
    ).rows[0].count,
    1,
  );
});

test('ORD-04 rejects foreign or missing details and malformed requests without partial writes', async () => {
  const id = await readOrder(customerId, [{ smallBoxCount: 1 }]);
  const other = await storedOrder(await readOrder(otherId, [{ smallBoxCount: 2 }]));
  const before = await storedOrder(id),
    beforeCounts = await counts();
  for (const parcelId of [other.parcels[0].orderParcelSeq, 2147483647])
    await errorCode(
      await patchOrder(id, {
        expectedVersion: before.version,
        paymentMethodType: 'billing',
        parcels: [{ smallBoxCount: 3 }, { orderParcelSeq: parcelId, smallBoxCount: 4 }],
      }),
      404,
      'NOT_FOUND',
    );
  for (const input of [
    { expectedVersion: before.version },
    { expectedVersion: before.version, parcels: [] },
    { expectedVersion: before.version, parcels: [{}] },
    { expectedVersion: before.version, parcels: [{ origin: {} }] },
    { expectedVersion: before.version, parcels: [{ destination: null }] },
    { expectedVersion: before.version, status: 'ACCEPTED' },
    { expectedVersion: before.version, customerSeq: otherId },
    {
      expectedVersion: before.version,
      parcels: [1, 2].map(() => ({
        orderParcelSeq: before.parcels[0].orderParcelSeq,
        smallBoxCount: 1,
      })),
    },
  ])
    await errorCode(await patchOrder(id, input), 400, 'INVALID_REQUEST');
  await errorCode(
    await patchOrder(2147483647, { expectedVersion: 1, paymentMethodType: 'billing' }),
    404,
    'NOT_FOUND',
  );
  for (const invalidId of ['abc', '0', '2147483648'])
    await errorCode(
      await patchOrder(invalidId, { expectedVersion: 1, paymentMethodType: 'billing' }),
      400,
      'INVALID_REQUEST',
    );
  assert.deepEqual(await storedOrder(id), before);
  assert.deepEqual(await counts(), beforeCounts);
});

test('ORD-04 concurrent saves across app instances append once with one winning version', async () => {
  const { customer } = await readCustomer();
  const id = await readOrder(customer),
    before = await storedOrder(id);
  const input = { expectedVersion: before.version, parcels: [{ smallBoxCount: 1 }] };
  const results = await Promise.all([0, 1, 2].map((index) => patchOrder(id, input, {}, index)));
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 409, 409]);
  const after = await storedOrder(id);
  assert.equal(after.parcels.length, 1);
  for (const response of results) {
    if (response.status === 200) assert.equal((await response.json()).data.version, after.version);
    else await errorCode(response, 409, 'VERSION_CONFLICT');
  }
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
        [id],
      )
    ).rows[0].count,
    1,
  );
});

test('ORD-04 rolls back header, details, call binding and success audit on storage failures', async () => {
  const { customer, phone } = await readCustomer();
  const id = await readOrder(customer, [{ smallBoxCount: 1 }]),
    callId = await call(phone);
  const before = await storedOrder(id),
    beforeCounts = await counts();
  const audit = apps[0].get(AuditService);
  const input = {
    expectedVersion: before.version,
    paymentMethodType: 'billing',
    parcels: [
      { orderParcelSeq: before.parcels[0].orderParcelSeq, smallBoxCount: 2 },
      { smallBoxCount: 3 },
    ],
  };
  for (const [owner, method] of [
    [repository, 'updateParcel'],
    [repository, 'insertParcels'],
    [audit, 'recordSuccess'],
  ]) {
    const original = owner[method];
    owner[method] = async function (...args) {
      const result = await original.apply(this, args);
      if (method !== 'recordSuccess' || args[0].action === 'ORDER_UPDATED')
        throw Error('update-rollback-test');
      return result;
    };
    try {
      assert.equal((await patchOrder(id, input, aiReadHeaders(callId))).status, 500);
    } finally {
      owner[method] = original;
    }
    assert.deepEqual(await storedOrder(id), before);
    assert.deepEqual(await counts(), beforeCounts);
    assert.equal(
      (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
        .rows[0].order_seq,
      null,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
          [id],
        )
      ).rows[0].count,
      0,
    );
  }
  assert.equal((await patchOrder(id, input, aiReadHeaders(callId))).status, 200);
});

test('ORD-04 AI rejects every non-COLLECTING state without changing orders or shipments', async () => {
  const { customer, phone } = await readCustomer();
  const callId = await call(phone);
  for (const status of [
    'notPaid',
    'PAID',
    'SUBMITTING',
    'ACCEPTED',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ]) {
    const id = await readOrder(customer, [{ smallBoxCount: 1 }]);
    await pool.query(
      "UPDATE orders SET status=$2,pickup_requested_at='2026-10-28T00:00:00Z',parcel_no=$3,dver_received_at=$4 WHERE order_seq=$1",
      [
        id,
        status,
        status === 'ACCEPTED' ? 'UPDT0061' : null,
        status === 'ACCEPTED' ? '2026-10-27T00:00:00Z' : null,
      ],
    );
    const before = await storedOrder(id);
    if (status === 'ACCEPTED')
      await pool.query(
        "INSERT INTO shipments(order_parcel_seq,tracking_number,status) VALUES($1,$2,'sent')",
        [before.parcels[0].orderParcelSeq, 'update-' + randomUUID()],
      );
    const snapshot = await storedOrder(id);
    await errorCode(
      await patchOrder(
        id,
        {
          expectedVersion: snapshot.version,
          parcels: [
            {
              orderParcelSeq: snapshot.parcels[0].orderParcelSeq,
              destination: { name: '변경 시도' },
            },
          ],
        },
        aiReadHeaders(callId),
      ),
      409,
      'INVALID_STATE',
    );
    assert.deepEqual(await storedOrder(id), snapshot);
  }
});

test('ORD-04 checks personal and company PIN access and permits clearing a revoked reference', async () => {
  const id = await readOrder(customerId, [{ smallBoxCount: 1 }]);
  let before = await storedOrder(id);
  const change = (pin) => ({
    expectedVersion: before.version,
    parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, originPin: pin }],
  });
  for (const pin of [
    { scope: 'PERSONAL', pinSeq: otherPin },
    { scope: 'COMPANY', pinSeq: 2147483647 },
  ])
    await errorCode(await patchOrder(id, change(pin)), 403, 'FORBIDDEN');
  assert.equal(
    (await patchOrder(id, change({ scope: 'COMPANY', pinSeq: companyPin }))).status,
    200,
  );
  before = await storedOrder(id);
  await pool.query("UPDATE memberships SET status='INACTIVE' WHERE customer_seq=$1", [customerId]);
  try {
    await errorCode(
      await patchOrder(id, {
        expectedVersion: before.version,
        parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, smallBoxCount: 2 }],
      }),
      403,
      'FORBIDDEN',
    );
    assert.deepEqual(await storedOrder(id), before);
    assert.equal((await patchOrder(id, change(null))).status, 200);
    assert.equal((await storedOrder(id)).parcels[0].originPin, null);
  } finally {
    await pool.query("UPDATE memberships SET status='ACTIVE' WHERE customer_seq=$1", [customerId]);
  }
});

test('ORD-04 AI continues an explicitly selected customer order and cannot replace a call binding', async () => {
  const { customer, phone } = await readCustomer();
  const callId = await call(phone),
    id = await readOrder(customer);
  const before = await storedOrder(id);
  const response = await patchOrder(
    id,
    { expectedVersion: before.version, parcels: [{ destination: { name: 'AI 수집' } }] },
    { ...aiReadHeaders(callId), Origin: undefined },
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
      .rows[0].order_seq,
    id,
  );
  const another = await readOrder(customer),
    other = await storedOrder(another);
  await errorCode(
    await patchOrder(
      another,
      { expectedVersion: other.version, paymentMethodType: 'billing' },
      aiReadHeaders(callId),
    ),
    409,
    'INVALID_STATE',
  );
  assert.deepEqual(await storedOrder(another), other);
  const staleCall = await call(phone);
  await errorCode(
    await patchOrder(
      id,
      { expectedVersion: before.version, paymentMethodType: 'billing' },
      aiReadHeaders(staleCall),
    ),
    409,
    'VERSION_CONFLICT',
  );
  assert.equal(
    (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [staleCall]))
      .rows[0].order_seq,
    null,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT actor_seq FROM audit_logs WHERE action='ORDER_UPDATED' AND target_seq=$1 AND result='SUCCESS'",
        [id],
      )
    ).rows[0].actor_seq,
    null,
  );
});

test('ORD-04 AI may finish a previously linked order after call end but cannot bind a new order', async () => {
  const { customer, phone } = await readCustomer();
  const callId = await call(phone);
  const response = await aiCreate(callId, { customerSeq: customer });
  assert.equal(response.status, 201);
  const { orderSeq: id, version } = (await response.json()).data;
  await pool.query(
    "UPDATE call_sessions SET started_at='2026-10-27T00:00:00Z',ended_at='2026-10-27T00:01:00Z' WHERE call_session_seq=$1",
    [callId],
  );
  const input = {
    expectedVersion: version,
    parcels: [{ destination: { name: '종료 전 수집한 내용' } }],
  };
  assert.equal((await patchOrder(id, input, aiReadHeaders(callId))).status, 200);
  await errorCode(await patchOrder(id, input, aiReadHeaders(callId)), 409, 'VERSION_CONFLICT');
  const recovery = await readDetail(id, aiReadHeaders(callId));
  assert.equal(recovery.status, 200);
  const recovered = (await recovery.json()).data;
  assert.equal(recovered.parcels.length, 1);
  assert.ok(recovered.version > version);
  assert.equal(
    (
      await patchOrder(
        id,
        {
          expectedVersion: recovered.version,
          parcels: [{ orderParcelSeq: recovered.parcels[0].orderParcelSeq, smallBoxCount: 1 }],
        },
        aiReadHeaders(callId),
      )
    ).status,
    200,
  );
  assert.equal((await storedOrder(id)).parcels.length, 1);
  await errorCode(await readOrders('', aiReadHeaders(callId)), 409, 'INVALID_STATE');
  const other = await readOrder(customer);
  await errorCode(await readDetail(other, aiReadHeaders(callId)), 409, 'INVALID_STATE');
  const unbound = await call(phone, true),
    before = await storedOrder(id);
  await errorCode(
    await patchOrder(
      id,
      { expectedVersion: before.version, paymentMethodType: 'billing' },
      aiReadHeaders(unbound),
    ),
    409,
    'INVALID_STATE',
  );
  assert.deepEqual(await storedOrder(id), before);
});

test('ORD-04 rejects AI calls without matching active customers, a valid call or the proper session', async () => {
  const { customer, phone } = await readCustomer();
  const id = await readOrder(customer),
    before = await storedOrder(id);
  const input = { expectedVersion: before.version, paymentMethodType: 'billing' };
  for (const callId of [await call(), await call('01000000003')])
    await errorCode(await patchOrder(id, input, aiReadHeaders(callId)), 403, 'FORBIDDEN');
  for (const header of [undefined, 'abc', '0', '2147483648'])
    await errorCode(
      await patchOrder(id, input, { Cookie: undefined, call_session_seq: header }),
      400,
      'INVALID_REQUEST',
    );
  await errorCode(await patchOrder(id, input, aiReadHeaders(2147483647)), 404, 'NOT_FOUND');
  const callId = await call(phone);
  for (const Cookie of ['dva_session=bad', 'dva_session=' + 'f'.repeat(64)])
    await errorCode(
      await patchOrder(id, input, { ...aiReadHeaders(callId), Cookie }),
      401,
      'UNAUTHORIZED',
    );
  for (const Origin of [undefined, 'https://untrusted.invalid'])
    await errorCode(await patchOrder(id, input, { Origin }), 403, 'FORBIDDEN');
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [customer]);
  await errorCode(await patchOrder(id, input, aiReadHeaders(callId)), 403, 'FORBIDDEN');
  await errorCode(await patchOrder(id, input), 403, 'FORBIDDEN');
  assert.deepEqual(await storedOrder(id), before);
});

test('ORD-04 all active administrator roles save without a call, inactive sessions fail', async () => {
  const { customer } = await readCustomer();
  const id = await readOrder(customer);
  for (const index of [0, 1, 2]) {
    const before = await storedOrder(id);
    assert.equal(
      (
        await patchOrder(
          id,
          { expectedVersion: before.version, paymentMethodType: 'billing' },
          {},
          index,
        )
      ).status,
      200,
    );
  }
  const before = await storedOrder(id);
  await pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [adminId]);
  try {
    await errorCode(
      await patchOrder(id, { expectedVersion: before.version, paymentMethodType: 'billing' }),
      401,
      'UNAUTHORIZED',
    );
  } finally {
    await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [adminId]);
  }
  assert.deepEqual(await storedOrder(id), before);
});

test('order APIs use the literal DB column header and reject former or hyphenated names', async () => {
  const { customer, phone } = await readCustomer();
  const id = await readOrder(customer),
    callId = await call(phone);
  const before = await storedOrder(id),
    beforeCounts = await counts();
  for (const name of ['X-Call-Session-Id', 'X-Call-Session-Seq', 'call-session-seq']) {
    const headers = { Cookie: undefined, [name]: String(callId) };
    await errorCode(
      await create({ customerSeq: customer }, randomUUID(), 0, headers),
      400,
      'INVALID_REQUEST',
    );
    await errorCode(await readOrders('', headers), 400, 'INVALID_REQUEST');
    await errorCode(await readDetail(id, headers), 400, 'INVALID_REQUEST');
    const response = await patchOrder(
      id,
      { expectedVersion: before.version, paymentMethodType: 'billing' },
      headers,
    );
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, 'INVALID_REQUEST');
    assert.ok(error.message.includes('call_session_seq'));
  }
  assert.deepEqual(await storedOrder(id), before);
  assert.deepEqual(await counts(), beforeCounts);
  // HTTP 헤더의 대소문자 구분 없음은 유지하며 밑줄 이름을 그대로 읽는다.
  assert.equal(
    (await readDetail(id, { Cookie: undefined, CALL_SESSION_SEQ: String(callId) })).status,
    200,
  );
  const spec = await (await fetch(hosts[0] + '/api/docs-json')).json();
  for (const operation of [
    spec.paths['/api/orders'].get,
    spec.paths['/api/orders'].post,
    spec.paths['/api/orders/{id}'].get,
    spec.paths['/api/orders/{id}'].patch,
  ]) {
    const headers = operation.parameters.filter(
      (parameter) => parameter.in === 'header' && parameter.name !== 'Idempotency-Key',
    );
    assert.equal(headers.length, 1);
    assert.equal(headers[0].name, 'call_session_seq');
    assert.ok(headers[0].description.includes('call_sessions.call_session_seq'));
  }
});

const readyOrder = async (changes = {}) => {
  const parcels = (
    changes.parcels ?? [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }]
  ).map((p) => ({ notifiedPrice: 3500, ...p }));
  const response = await create({
    customerSeq: otherId,
    paymentMethodType: 'credit',
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    ...changes,
    parcels,
    totalAmount: changes.totalAmount ?? parcels.reduce((n, p) => n + (p.notifiedPrice ?? 0), 0),
  });
  assert.equal(response.status, 201);
  return (await response.json()).data;
};
const submitOrder = (order, extra = {}, index = 0, body = { expectedVersion: order.version }) =>
  fetch(hosts[index] + `/api/orders/${order.orderSeq}/submit`, {
    method: 'POST',
    headers: Object.fromEntries(
      Object.entries({
        Origin: origin,
        Cookie: cookies[index],
        'Content-Type': 'application/json',
        ...extra,
      }).filter(([, value]) => value !== undefined),
    ),
    body: JSON.stringify(body),
  });
const cancelOrder = (id, parcels, index = 0) =>
  fetch(hosts[index] + `/api/orders/${id}${parcels === undefined ? '' : '/parcels'}/cancel`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookies[index], 'Content-Type': 'application/json' },
    body: parcels === undefined ? undefined : JSON.stringify({ orderParcelSeqs: parcels }),
  });
const resetDver = () => {
  dverRequests = [];
  dverRespond = (_req, res) => res.end(JSON.stringify(dverSuccess));
};

const aiResult = (outcome = 'COMPLETE', changes = {}) => {
  const parcels = (
    changes.parcels ?? [{ origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }]
  ).map((p) => ({ notifiedPrice: 3500, ...p }));
  return {
    outcome,
    call: {
      providerCallId: randomUUID(),
      callerPhoneNumber: '+821000000001',
      incomingAt: '2026-10-27T01:00:00Z',
    },
    customerSeq: customerId,
    paymentMethodType: 'credit',
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    ...changes,
    parcels,
    totalAmount: changes.totalAmount ?? parcels.reduce((n, p) => n + (p.notifiedPrice ?? 0), 0),
  };
};

test('AI sends COMPLETE once to ORD-01 and receives the committed Dver result without submit', async () => {
  resetDver();
  const input = aiResult(),
    key = randomUUID();
  const response = await aiCreate(undefined, input, key);
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.equal(data.status, 'ACCEPTED');
  assert.equal(data.parcelNo, dverSuccess.parcelNo);
  assert.ok(data.callSessionSeq > 0);
  assert.deepEqual(await submissionRows(data.orderSeq), {
    status: 'ACCEPTED',
    shipments: 1,
    history: 1,
    acceptedAudit: 1,
  });
  const stored = (
    await pool.query(
      'SELECT caller_phone_number,incoming_at,order_seq FROM call_sessions WHERE call_session_seq=$1',
      [data.callSessionSeq],
    )
  ).rows[0];
  assert.equal(stored.caller_phone_number, '01000000001');
  assert.equal(stored.incoming_at.toISOString(), input.call.incomingAt.replace('00Z', '00.000Z'));
  assert.equal(stored.order_seq, data.orderSeq);
  const events = (
    await pool.query(
      "SELECT action,actor_type,actor_seq,actor_name FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' ORDER BY audit_log_seq",
      [response.headers.get('x-request-id')],
    )
  ).rows;
  assert.deepEqual(
    events.map((event) => event.action),
    [
      'CALL_STARTED',
      'ORDER_CREATED',
      'BILLING_MONTH_INITIALIZED',
      'BILLING_MONTH_INITIALIZED',
      'BILLING_AMOUNT_INCREASED',
      'ORDER_PAYMENT_COMPLETED',
      'ORDER_SUBMISSION_STARTED',
      'ORDER_SUBMISSION_ACCEPTED',
    ],
  );
  assert.ok(
    events
      .slice(0, 2)
      .every(
        (event) =>
          event.actor_type === 'AI' && event.actor_seq === null && event.actor_name === 'AI',
      ),
  );
  assert.ok(
    events.slice(2).every((event) => event.actor_type === 'SYSTEM' && event.actor_seq === null),
  );
  assert.deepEqual(
    (await (await aiCreate(undefined, { ...input, outcome: 'CANCELLED' }, key, 1)).json()).data,
    data,
  );
  assert.equal(dverRequests.length, 1);
});

test('AI incomplete and cancelled calls survive without a known customer and never call Dver', async () => {
  resetDver();
  const beforeCustomers = (await counts()).customers;
  for (const outcome of ['INCOMPLETE', 'CANCELLED']) {
    const input = aiResult(outcome, {
      customerSeq: undefined,
      call: {
        providerCallId: randomUUID(),
        callerPhoneNumber: '01099118822',
        incomingAt: '2026-10-27T01:00:00Z',
      },
      parcels: [{ origin: { roadAddress: '수집된 주소' } }],
    });
    const key = randomUUID();
    const response = await aiCreate(undefined, input, key);
    assert.equal(response.status, 201);
    const { data } = await response.json();
    assert.equal(data.status, outcome === 'INCOMPLETE' ? 'COLLECTING' : 'CANCELLED');
    assert.equal(data.parcelNo, null);
    assert.equal(data.totalAmount, outcome === 'CANCELLED' ? 0 : input.totalAmount);
    if (outcome === 'CANCELLED') {
      const event = (
        await pool.query(
          "SELECT actor_type,metadata FROM audit_logs WHERE target_seq=$1 AND action='ORDER_CANCELLED'",
          [data.orderSeq],
        )
      ).rows[0];
      assert.equal(event.actor_type, 'AI');
      assert.deepEqual(event.metadata, { amountBefore: input.totalAmount, amountAfter: 0 });
      assert.equal(
        (
          await pool.query('SELECT notified_price FROM order_parcels WHERE order_seq=$1', [
            data.orderSeq,
          ])
        ).rows[0].notified_price,
        input.parcels[0].notifiedPrice,
      );
    }
    const stored = (
      await pool.query('SELECT customer_seq FROM orders WHERE order_seq=$1', [data.orderSeq])
    ).rows[0];
    assert.equal(stored.customer_seq, null);
    assert.deepEqual((await (await aiCreate(undefined, input, key)).json()).data, data);
  }
  assert.equal((await counts()).customers, beforeCustomers);
  assert.equal(dverRequests.length, 0);
});

test('AI COMPLETE validation rolls back call, customer and order before any Dver request', async () => {
  resetDver();
  const before = await counts();
  const input = aiResult('COMPLETE', {
    customerSeq: undefined,
    customer: { name: '검증 실패', phoneNumber: '01088990011' },
    parcels: [],
    totalAmount: 3500,
  });
  input.call.callerPhoneNumber = input.customer.phoneNumber;
  await errorCode(await aiCreate(undefined, input), 422, 'VALIDATION_FAILED');
  assert.deepEqual(await counts(), before);
  assert.equal(
    (
      await pool.query('SELECT 1 FROM call_sessions WHERE provider_call_id=$1', [
        input.call.providerCallId,
      ])
    ).rowCount,
    0,
  );
  assert.equal(dverRequests.length, 0);
});

test('AI result identity cannot change phone or event timestamp; another key cannot duplicate the call order', async () => {
  const input = aiResult('INCOMPLETE'),
    key = randomUUID();
  assert.equal((await aiCreate(undefined, input, key)).status, 201);
  for (const callChange of [
    { incomingAt: '2026-10-27T01:00:01Z' },
    { callerPhoneNumber: '01011112222' },
  ])
    await errorCode(
      await aiCreate(undefined, { ...input, call: { ...input.call, ...callChange } }, key),
      409,
      'INVALID_STATE',
    );
  await errorCode(await aiCreate(undefined, input), 409, 'INVALID_STATE');
});

test('AI COMPLETE retries while Dver is running return SUBMITTING across application instances', async () => {
  resetDver();
  let received;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  let finish;
  dverRespond = (_req, res) => {
    finish = () => res.end(JSON.stringify(dverSuccess));
    received();
  };
  const input = aiResult(),
    key = randomUUID();
  const first = aiCreate(undefined, input, key);
  await arrived;
  try {
    const replay = await aiCreate(undefined, input, key, 1);
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).data.status, 'SUBMITTING');
    assert.equal(dverRequests.length, 1);
  } finally {
    finish();
  }
  assert.equal((await (await first).json()).data.status, 'ACCEPTED');
});

test('AI COMPLETE reports upstream rejection or uncertainty and never resends on retry', async () => {
  for (const status of [403, 500]) {
    resetDver();
    dverRespond = (_req, res) => {
      res.writeHead(status);
      res.end('{}');
    };
    const input = aiResult(),
      key = randomUUID();
    const response = await aiCreate(undefined, input, key);
    const { data } = await response.json();
    assert.equal(data.status, status === 403 ? 'SUBMISSION_FAILED' : 'SUBMISSION_FAILED');
    assert.equal((await submissionRows(data.orderSeq)).shipments, 0);
    assert.deepEqual((await (await aiCreate(undefined, input, key)).json()).data, data);
    assert.equal(dverRequests.length, 1);
  }
});
const submissionRows = async (id) =>
  (
    await pool.query(
      `SELECT
  (SELECT status FROM orders WHERE order_seq=$1) AS status,
  (SELECT count(*)::int FROM shipments s JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1) AS shipments,
  (SELECT count(*)::int FROM shipment_status_history h JOIN shipments s USING(shipment_seq) JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1) AS history,
  (SELECT count(*)::int FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND action='ORDER_SUBMISSION_ACCEPTED' AND result='SUCCESS') AS "acceptedAudit"`,
      [id],
    )
  ).rows[0];

test('AI cannot edit cancelled draft details or sent to Dver, and only remaining details get shipments', async () => {
  resetDver();
  const order = await readyOrder({
    parcels: [{}, { origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 }],
  });
  const callId = await call('01000000003');
  const before = (await (await readDetail(order.orderSeq)).json()).data;
  const [cancelled, active] = before.parcels;
  // A deleted/obsolete PIN on a cancelled snapshot must not block the remaining parcel.
  await pool.query(
    "UPDATE order_parcels SET origin_pin_scope='PERSONAL',origin_pin_seq=2147483647 WHERE order_parcel_seq=$1",
    [cancelled.orderParcelSeq],
  );
  assert.equal((await cancelOrder(order.orderSeq, [cancelled.orderParcelSeq])).status, 204);
  const partial = (await (await readDetail(order.orderSeq)).json()).data;
  assert.equal(partial.status, 'COLLECTING');
  assert.deepEqual(
    partial.parcels.map((p) => p.status),
    ['CANCELLED', 'ACTIVE'],
  );
  await errorCode(
    await patchOrder(
      order.orderSeq,
      {
        expectedVersion: partial.version,
        paymentMethodType: 'billing',
        parcels: [
          { orderParcelSeq: active.orderParcelSeq, clientComment: 'must roll back' },
          { orderParcelSeq: cancelled.orderParcelSeq, clientComment: 'must reject' },
        ],
      },
      aiReadHeaders(callId),
    ),
    409,
    'INVALID_STATE',
  );
  assert.deepEqual((await (await readDetail(order.orderSeq)).json()).data, partial);
  await errorCode(await submitOrder(order), 409, 'VERSION_CONFLICT');
  assert.equal(dverRequests.length, 0);
  assert.equal((await submitOrder({ ...order, version: partial.version })).status, 200);
  assert.equal(dverRequests.length, 1);
  assert.equal(dverRequests[0].body.outboundParcels.length, 1);
  assert.equal(dverRequests[0].body.outboundParcels[0].item.smallBox, 1);
  assert.deepEqual(await submissionRows(order.orderSeq), {
    status: 'ACCEPTED',
    shipments: 1,
    history: 1,
    acceptedAudit: 1,
  });
  assert.equal(
    (
      await pool.query('SELECT 1 FROM shipments WHERE order_parcel_seq=$1', [
        cancelled.orderParcelSeq,
      ])
    ).rowCount,
    0,
  );
  const accepted = (await (await readDetail(order.orderSeq)).json()).data;
  assert.deepEqual(
    accepted.parcels.map((p) => p.status),
    ['CANCELLED', 'ACTIVE'],
  );
  const history = await fetch(
    hosts[0] + `/api/customers/${otherId}/addresses?direction=DESTINATION&limit=100`,
    { headers: { Cookie: cookies[0] } },
  );
  const historical = (await history.json()).data.filter((p) => p.orderSeq === order.orderSeq);
  assert.deepEqual(
    historical.map((p) => p.orderParcelSeq),
    [active.orderParcelSeq],
  );
});

test('cancelled accepted snapshots stay out of previous address suggestions while siblings remain', async () => {
  resetDver();
  const parcel = { origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 };
  const order = await readyOrder({ paymentMethodType: 'billing', parcels: [parcel, parcel] });
  assert.equal((await submitOrder(order)).status, 200);
  const detail = (await (await readDetail(order.orderSeq)).json()).data;
  assert.equal((await cancelOrder(order.orderSeq, [detail.parcels[0].orderParcelSeq])).status, 204);
  const remaining = (await (await readDetail(order.orderSeq)).json()).data;
  const payments = apps[0].get(OrderPaymentsService);
  await payments.beginPayment(remaining.paymentRequest.paymentRequestId, remaining.totalAmount);
  await payments.confirmPayment(
    remaining.paymentRequest.paymentRequestId,
    remaining.totalAmount,
    'verified-' + randomUUID(),
    randomUUID(),
  );
  assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
  const history = await fetch(
    hosts[0] + `/api/customers/${otherId}/addresses?direction=DESTINATION&limit=100`,
    { headers: { Cookie: cookies[0] } },
  );
  assert.deepEqual(
    (await history.json()).data
      .filter((p) => p.orderSeq === order.orderSeq)
      .map((p) => p.orderParcelSeq),
    [detail.parcels[1].orderParcelSeq],
  );
  await errorCode(await cancelOrder(order.orderSeq), 409, 'INVALID_STATE');
  assert.equal(dverRequests.length, 1, 'cancellation must not contact Dver');
});

test('whole and individual cancellation reject SUBMITTING while Dver is in flight', async () => {
  resetDver();
  let received, finish;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  dverRespond = (_req, res) => {
    finish = () => res.end(JSON.stringify(dverSuccess));
    received();
  };
  const order = await readyOrder();
  const detail = (await (await readDetail(order.orderSeq)).json()).data;
  const pending = submitOrder(order);
  await arrived;
  try {
    await errorCode(await cancelOrder(order.orderSeq, undefined, 1), 409, 'INVALID_STATE');
    await errorCode(
      await cancelOrder(order.orderSeq, [detail.parcels[0].orderParcelSeq], 2),
      409,
      'INVALID_STATE',
    );
  } finally {
    finish();
  }
  assert.equal((await pending).status, 200);
  assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
  assert.equal(dverRequests.length, 1);
});

test('AI CANCELLED consultation creates cancelled details and stays separate from cancelling an existing order', async () => {
  resetDver();
  const result = await aiCreate(undefined, aiResult('CANCELLED', { parcels: [{}] }));
  assert.equal(result.status, 201);
  const { data } = await result.json();
  const detail = (await (await readDetail(data.orderSeq)).json()).data;
  assert.equal(detail.status, 'CANCELLED');
  assert.equal(detail.parcels[0].status, 'CANCELLED');
  assert.equal(dverRequests.length, 0);
});

test('ORD-06 submits the existing order and atomically creates each shipment and initial history', async () => {
  resetDver();
  assert.equal(
    (
      await pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name LIKE 'submission_%'",
      )
    ).rowCount,
    0,
  );
  const order = await readyOrder({
    parcels: [
      { origin: address, destination: address, smallBoxCount: 1, itemPrice: 0 },
      { origin: address, destination: address, otherItemDescription: '기타', itemPrice: 3000 },
    ],
  });
  const requestId = randomUUID(),
    before = await counts();
  const response = await submitOrder(order, { 'X-Request-Id': requestId });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: { status: 'ACCEPTED' }, meta: { requestId } });
  assert.equal(dverRequests.length, 1);
  assert.equal(dverRequests[0].headers['x-api-key'], 'test-only-dver-key');
  assert.equal(dverRequests[0].body.outboundParcels.length, 2);
  assert.equal(dverRequests[0].body.paymentMethodType, 'credit');
  assert.ok(dverRequests[0].body.outboundParcels.every((p) => p.notifiedPrice === 3500));
  assert.equal((await counts()).orders, before.orders);
  assert.deepEqual(await submissionRows(order.orderSeq), {
    status: 'ACCEPTED',
    shipments: 2,
    history: 2,
    acceptedAudit: 1,
  });
  const detail = await storedOrder(order.orderSeq);
  assert.equal(detail.parcelNo, dverSuccess.parcelNo);
  assert.equal(Date.parse(detail.dverReceivedAt), Date.parse(dverSuccess.receivedAt));
  assert.equal(detail.status, 'ACCEPTED');
  assert.ok(detail.parcels.every((parcel) => !Object.hasOwn(parcel, 'shipment')));
  const shipments = (
    await pool.query(
      `SELECT s.status,s.version,s.tracking_number FROM shipments s
       JOIN order_parcels p USING(order_parcel_seq) WHERE p.order_seq=$1`,
      [order.orderSeq],
    )
  ).rows;
  assert.equal(new Set(shipments.map((shipment) => shipment.tracking_number)).size, 2);
  for (const shipment of shipments) {
    assert.equal(shipment.status, 'paid');
    assert.equal(shipment.version, 1);
    assert.match(shipment.tracking_number, /^DVA-[0-9a-f-]{36}$/);
  }
  await pool.query('UPDATE orders SET version=version+1 WHERE order_seq=$1', [order.orderSeq]);
  const retry = await submitOrder(order, {}, 1);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).data.status, 'ACCEPTED');
  assert.equal(dverRequests.length, 1);
  assert.equal((await submissionRows(order.orderSeq)).history, 2);
  assert.equal((await submitOrder(order)).status, 200);
});

test('submission still rejects existing shipments after removing them from order detail', async () => {
  resetDver();
  const order = await readyOrder();
  await pool.query(
    `INSERT INTO shipments(order_parcel_seq,tracking_number)
     SELECT order_parcel_seq,$2 FROM order_parcels WHERE order_seq=$1`,
    [order.orderSeq, randomUUID()],
  );
  const before = await storedOrder(order.orderSeq);
  assert.ok(before.parcels.every((parcel) => !Object.hasOwn(parcel, 'shipment')));
  await errorCode(await submitOrder(order), 409, 'INVALID_STATE');
  assert.equal(dverRequests.length, 0);
  assert.deepEqual(await storedOrder(order.orderSeq), before);
  assert.deepEqual(await submissionRows(order.orderSeq), {
    status: 'COLLECTING',
    shipments: 1,
    history: 0,
    acceptedAudit: 0,
  });
});

test('ORD-06 payment eligibility uses active enterprise membership and allows credit for both kinds', async () => {
  resetDver();
  const { customer: personalCustomer } = await readCustomer();
  for (const [customerSeq, paymentMethodType, expected] of [
    [customerId, 'credit', 200],
    [personalCustomer, 'credit', 200],
    [customerId, 'groupBilling', 200],
    [personalCustomer, 'billing', 200],
    [customerId, 'billing', 200],
    [personalCustomer, 'groupBilling', 403],
  ]) {
    const order = await readyOrder({ customerSeq, paymentMethodType }),
      before = dverRequests.length;
    const response = await submitOrder(order);
    assert.equal(response.status, expected, `${customerSeq} ${paymentMethodType}`);
    if (expected === 200) {
      assert.equal(
        (await response.json()).data.status,
        paymentMethodType === 'billing' ? 'notPaid' : 'ACCEPTED',
      );
      if (paymentMethodType === 'billing') assert.equal(dverRequests.length, before);
      else assert.equal(dverRequests.at(-1).body.paymentMethodType, paymentMethodType);
    } else {
      assert.equal((await response.json()).error.code, 'FORBIDDEN');
      assert.equal(dverRequests.length, before);
      assert.equal((await submissionRows(order.orderSeq)).status, 'COLLECTING');
    }
  }
  for (const [table, column, id] of [
    ['memberships', 'customer_seq', customerId],
    ['organizations', 'organization_seq', organizationId],
  ]) {
    const order = await readyOrder({ customerSeq: customerId, paymentMethodType: 'groupBilling' }),
      before = dverRequests.length;
    await pool.query(`UPDATE ${table} SET status='INACTIVE' WHERE ${column}=$1`, [id]);
    try {
      await errorCode(await submitOrder(order), 403, 'FORBIDDEN');
    } finally {
      await pool.query(`UPDATE ${table} SET status='ACTIVE' WHERE ${column}=$1`, [id]);
    }
    assert.equal(dverRequests.length, before);
  }
});

test('ORD-06 checks saved completeness, legacy cat, active customer and PIN; validation failures preserve the collecting order', async () => {
  resetDver();
  const partial = await readyOrder({ pickupRequestedAt: null, parcels: [{}] });
  const response = await submitOrder(partial);
  assert.equal(response.status, 422);
  const failure = (await response.json()).error;
  assert.equal(failure.code, 'VALIDATION_FAILED');
  assert.ok(failure.details.some((x) => x.field === 'parcels.0.origin.name'));
  assert.equal((await submissionRows(partial.orderSeq)).status, 'COLLECTING');
  const legacy = await readyOrder();
  await pool.query("UPDATE orders SET payment_method_type='cat' WHERE order_seq=$1", [
    legacy.orderSeq,
  ]);
  legacy.version = (await storedOrder(legacy.orderSeq)).version;
  await errorCode(await submitOrder(legacy), 422, 'VALIDATION_FAILED');
  const withdrawn = await readyOrder();
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [otherId]);
  try {
    await errorCode(await submitOrder(withdrawn), 403, 'FORBIDDEN');
  } finally {
    await pool.query("UPDATE customers SET status='ACTIVE' WHERE customer_seq=$1", [otherId]);
  }
  const pin = await readyOrder({
    customerSeq: customerId,
    parcels: [
      {
        origin: address,
        destination: address,
        smallBoxCount: 1,
        itemPrice: 0,
        originPin: { scope: 'COMPANY', pinSeq: companyPin },
      },
    ],
  });
  await pool.query("UPDATE memberships SET status='INACTIVE' WHERE customer_seq=$1", [customerId]);
  try {
    await errorCode(await submitOrder(pin), 403, 'FORBIDDEN');
  } finally {
    await pool.query("UPDATE memberships SET status='ACTIVE' WHERE customer_seq=$1", [customerId]);
  }
  assert.equal(dverRequests.length, 0);
  const patched = await patchOrder(partial.orderSeq, {
    expectedVersion: partial.version,
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    parcels: [
      {
        orderParcelSeq: (await storedOrder(partial.orderSeq)).parcels[0].orderParcelSeq,
        origin: address,
        destination: address,
        smallBoxCount: 1,
        itemPrice: 0,
      },
    ],
  });
  assert.equal(patched.status, 200);
  partial.version = (await patched.json()).data.version;
  assert.equal((await submitOrder(partial)).status, 200);
});

test('ORD-06 rejects invalid path/body and keeps session and Origin checks', async () => {
  resetDver();
  const order = await readyOrder();
  for (const body of [
    {},
    { expectedVersion: '1' },
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { expectedVersion: 2147483648 },
    { expectedVersion: order.version, confirmed: true },
    { expectedVersion: order.version, parcels: [] },
  ])
    await errorCode(await submitOrder(order, {}, 0, body), 400, 'INVALID_REQUEST');
  await errorCode(await submitOrder({ ...order, orderSeq: 0 }), 400, 'INVALID_REQUEST');
  await errorCode(await submitOrder({ ...order, orderSeq: 2147483647 }), 404, 'NOT_FOUND');
  await errorCode(
    await submitOrder({ ...order, version: order.version + 1 }),
    409,
    'VERSION_CONFLICT',
  );
  await errorCode(
    await submitOrder(order, { Origin: 'https://untrusted.invalid' }),
    403,
    'FORBIDDEN',
  );
  await errorCode(await submitOrder(order, { Cookie: 'dva_session=broken' }), 401, 'UNAUTHORIZED');
  await errorCode(
    await submitOrder(order, { Cookie: undefined, Origin: undefined }),
    400,
    'INVALID_REQUEST',
  );
  assert.equal(dverRequests.length, 0);
});

test('ORD-06 AI requires matching phone and active call; an ended call can replay its bound order', async () => {
  resetDver();
  const { customer, phone } = await readCustomer();
  const order = await readyOrder({ customerSeq: customer });
  for (const callId of [await call(), await call('01099990000')])
    await errorCode(await submitOrder(order, aiReadHeaders(callId)), 403, 'FORBIDDEN');
  const ended = await call(phone, true);
  await pool.query('UPDATE call_sessions SET order_seq=$2 WHERE call_session_seq=$1', [
    ended,
    order.orderSeq,
  ]);
  await errorCode(await submitOrder(order, aiReadHeaders(ended)), 409, 'INVALID_STATE');
  const callId = await call(phone);
  assert.equal((await submitOrder(order, aiReadHeaders(callId))).status, 200);
  assert.equal(
    (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
      .rows[0].order_seq,
    order.orderSeq,
  );
  await pool.query(
    'UPDATE call_sessions SET started_at=now(),ended_at=now() WHERE call_session_seq=$1',
    [callId],
  );
  assert.equal((await submitOrder(order, aiReadHeaders(callId), 1)).status, 200);
  assert.equal(dverRequests.length, 1);
  assert.equal((await submitOrder(order, aiReadHeaders(callId))).status, 200);
  const unboundEnded = await call(phone, true);
  await errorCode(await submitOrder(order, aiReadHeaders(unboundEnded)), 409, 'INVALID_STATE');
  await errorCode(
    await submitOrder(order, aiReadHeaders(await call('01099990000'))),
    403,
    'FORBIDDEN',
  );
});

test('ORD-06 uses the order identity, ignores obsolete keys and rejects cancelled or expired orders', async () => {
  resetDver();
  const first = await readyOrder(),
    second = await readyOrder();
  const headers = { 'Idempotency-Key': randomUUID() };
  assert.equal((await submitOrder(first, headers)).status, 200);
  assert.equal((await submitOrder(second, headers)).status, 200);
  const replay = await submitOrder({ ...first, version: first.version + 1 });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.status, 'ACCEPTED');
  for (const status of ['CANCELLED']) {
    const order = await readyOrder();
    await pool.query('UPDATE orders SET status=$2 WHERE order_seq=$1', [order.orderSeq, status]);
    await errorCode(await submitOrder(order), 409, 'INVALID_STATE');
  }
  assert.equal(dverRequests.length, 2);
});

test('ORD-06 commits SUBMITTING and releases locks before HTTP; concurrent retries only return status', async () => {
  resetDver();
  const order = await readyOrder();
  let release, received;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  dverRespond = (_req, res) => {
    release = () => res.end(JSON.stringify(dverSuccess));
    received();
  };
  const first = submitOrder(order);
  try {
    await Promise.race([
      arrived,
      first.then((response) => {
        throw Error(`Request ended before external call: ${response.status}`);
      }),
    ]);
    const locked = await pool.connect();
    try {
      await locked.query('BEGIN');
      const row = (
        await locked.query(
          'SELECT status,version FROM orders WHERE order_seq=$1 FOR UPDATE NOWAIT',
          [order.orderSeq],
        )
      ).rows[0];
      assert.equal(row.status, 'SUBMITTING');
      assert.equal(row.version, order.version + 1); // Payment fixes the pickup time.
    } finally {
      await locked.query('ROLLBACK');
      locked.release();
    }
    const retry = await submitOrder(order, {}, 1);
    assert.equal(retry.status, 202);
    assert.equal(retry.headers.get('location'), `/api/orders/${order.orderSeq}`);
    assert.equal((await retry.json()).data.status, 'SUBMITTING');
    assert.equal((await submitOrder(order, {}, 2)).status, 202);
    await errorCode(
      await patchOrder(
        order.orderSeq,
        { expectedVersion: order.version, paymentMethodType: 'credit' },
        aiReadHeaders(await call('01000000003')),
      ),
      409,
      'INVALID_STATE',
    );
    assert.equal(dverRequests.length, 1);
  } finally {
    release?.();
    await first;
  }
  assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
});

test('ORD-06 serializes concurrent preparation on the existing order row', async () => {
  resetDver();
  const order = await readyOrder();
  const originalStart = submissionRepository.start;
  const secondRepository = apps[1].get(OrdersRepository);
  const originalLock = secondRepository.lockOrder;
  let release, entered, attempted;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const preparing = new Promise((resolve) => {
    entered = resolve;
  });
  const competing = new Promise((resolve) => {
    attempted = resolve;
  });
  submissionRepository.start = async function (...args) {
    const result = await originalStart.apply(this, args);
    entered();
    await gate;
    return result;
  };
  secondRepository.lockOrder = function (...args) {
    const result = originalLock.apply(this, args);
    attempted();
    return result;
  };
  const first = submitOrder(order);
  let second;
  try {
    await Promise.race([
      preparing,
      first.then((r) => {
        throw Error(`Preparation failed: ${r.status}`);
      }),
    ]);
    second = submitOrder(order, {}, 1);
    await Promise.race([
      competing,
      second.then((r) => {
        throw Error(`Competing request failed: ${r.status}`);
      }),
    ]);
    assert.equal(dverRequests.length, 0);
  } finally {
    release();
    submissionRepository.start = originalStart;
    secondRepository.lockOrder = originalLock;
  }
  assert.equal((await first).status, 200);
  const replay = await second;
  assert.ok([200, 202].includes(replay.status));
  assert.ok(['ACCEPTED', 'SUBMITTING'].includes((await replay.json()).data.status));
  assert.equal((await submitOrder(order, {}, 2)).status, 200);
  assert.equal(dverRequests.length, 1);
});

test('ORD-06 records auth failures and unknown outcomes without shipments or a second external request', async () => {
  for (const mode of ['auth', 'error', 'invalid', 'disconnect']) {
    resetDver();
    const order = await readyOrder();
    dverRespond = (req, res) => {
      if (mode === 'disconnect') return req.socket.destroy();
      res.statusCode = mode === 'auth' ? 403 : mode === 'error' ? 500 : 200;
      res.end(mode === 'auth' ? 'Authorization data is wrong!' : '{}');
    };
    const response = await submitOrder(order);
    assert.equal(response.status, 200);
    const status = 'SUBMISSION_FAILED';
    assert.equal((await response.json()).data.status, status);
    assert.deepEqual(await submissionRows(order.orderSeq), {
      status,
      shipments: 0,
      history: 0,
      acceptedAudit: 0,
    });
    assert.equal((await submitOrder(order, {}, 1)).status, 200);
    assert.equal((await submitOrder(order)).status, 200);
    assert.equal(dverRequests.length, 1);
  }
});

test('ORD-06 configuration failure prevents payment; dispatch audit failure preserves paid order for recovery', async () => {
  resetDver();
  const { customer, phone } = await readCustomer();
  const order = await readyOrder({ customerSeq: customer }),
    callId = await call(phone);
  const config = apps[0].get(ConfigService),
    audit = apps[0].get(AuditService);
  config.set('DVER_API_KEY', '');
  try {
    await errorCode(await submitOrder(order), 503, 'DEPENDENCY_UNAVAILABLE');
  } finally {
    config.set('DVER_API_KEY', 'test-only-dver-key');
  }
  const original = audit.recordSuccess;
  audit.recordSuccess = async function (...args) {
    await original.apply(this, args);
    if (args[0].action === 'ORDER_SUBMISSION_STARTED') throw Error('submit-prepare-rollback');
  };
  try {
    assert.equal((await submitOrder(order, aiReadHeaders(callId))).status, 500);
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual(await submissionRows(order.orderSeq), {
    status: 'PAID',
    shipments: 0,
    history: 0,
    acceptedAudit: 0,
  });
  assert.equal(
    (await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [callId]))
      .rows[0].order_seq,
    order.orderSeq,
  );
  assert.equal(dverRequests.length, 0);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_seq=$1 AND action='ORDER_PAYMENT_COMPLETED'",
        [order.orderSeq],
      )
    ).rows[0].n,
    1,
  );
  assert.equal((await submitOrder(order)).status, 200);
  assert.equal((await submissionRows(order.orderSeq)).status, 'ACCEPTED');
  assert.equal(dverRequests.length, 1);
});

test('ORD-06 result storage failure rolls back shipments/audit and stale SUBMITTING becomes review without resending', async () => {
  for (const failure of ['shipment', 'audit']) {
    resetDver();
    const order = await readyOrder();
    const owner = failure === 'shipment' ? submissionRepository : apps[0].get(AuditService);
    const method = failure === 'shipment' ? 'finish' : 'recordSuccess',
      original = owner[method];
    owner[method] = async function (...args) {
      await original.apply(this, args);
      if (failure === 'shipment' || args[0].action === 'ORDER_SUBMISSION_ACCEPTED')
        throw Error('submit-finalize-rollback');
    };
    try {
      const response = await submitOrder(order);
      assert.equal(response.status, 202);
      assert.equal((await response.json()).data.status, 'SUBMITTING');
    } finally {
      owner[method] = original;
    }
    assert.deepEqual(await submissionRows(order.orderSeq), {
      status: 'SUBMITTING',
      shipments: 0,
      history: 0,
      acceptedAudit: 0,
    });
    assert.equal((await submitOrder(order, {}, 1)).status, 202);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Set an old timestamp only in the disposable fixture; restore the trigger before commit.
      await client.query('ALTER TABLE orders DISABLE TRIGGER order_header_timestamp');
      await client.query(
        "UPDATE orders SET updated_at=now()-interval '2 minutes' WHERE order_seq=$1",
        [order.orderSeq],
      );
      await client.query('ALTER TABLE orders ENABLE TRIGGER order_header_timestamp');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const recovery = await submitOrder(order, {}, 1);
    assert.equal(recovery.status, 200);
    assert.equal((await recovery.json()).data.status, 'SUBMISSION_FAILED');
    assert.equal((await submitOrder(order)).status, 200);
    assert.equal(dverRequests.length, 1);
  }
});

test('ORD-06 stored submission state survives a new application instance without a request key', async () => {
  resetDver();
  const order = await readyOrder();
  assert.equal((await submitOrder(order)).status, 200);
  const app = await NestFactory.create(AppModule, { logger: false });
  apps.push(app);
  configureApplication(app, { log: () => {} });
  await app.listen(0, '127.0.0.1');
  const response = await fetch((await app.getUrl()) + `/api/orders/${order.orderSeq}/submit`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: cookies[0],
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expectedVersion: order.version }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'ACCEPTED');
  assert.equal(dverRequests.length, 1);
});

test('ORD-06 waits for membership eligibility and continues the original request', async () => {
  resetDver();
  const order = await readyOrder({ customerSeq: customerId, paymentMethodType: 'groupBilling' });
  const lock = await pool.connect();
  let pending;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT membership_seq FROM memberships WHERE customer_seq=$1 FOR UPDATE', [
      customerId,
    ]);
    pending = submitOrder(order);
    await waitForBlockedBy(lock.processID);
    assert.equal(dverRequests.length, 0);
    assert.equal((await submissionRows(order.orderSeq)).status, 'COLLECTING');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
    if (pending) await pending;
  }
  assert.equal((await pending).status, 200);
  assert.equal(dverRequests.length, 1);
});

async function waitForBlockedBy(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await pool.query(
      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
      [pid],
    );
    if (rows[0].waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expected a database lock wait');
}

for (const operation of ['create', 'update', 'submit']) {
  test(
    'lock ordering lets ' + operation + ' finish before a waiting membership change',
    async () => {
      resetDver();
      const { CustomersRepository } = require('../dist/customers/customers.repository');
      const customers = apps[0].get(CustomersRepository);
      const { customer, phone } = await readCustomer();
      const employeeNo = String(customer);
      const membership = (
        await testMembership(pool, {
          customerSeq: customer,
          organizationSeq: organizationId,
          employeeNo,
        })
      ).rows[0].membership_seq;
      const department = (
        await pool.query('SELECT department_seq FROM memberships WHERE membership_seq=$1', [
          membership,
        ])
      ).rows[0].department_seq;
      const parcel = {
        originPin: { scope: 'COMPANY', pinSeq: companyPin },
        origin: address,
        destination: address,
        smallBoxCount: 1,
        itemPrice: 0,
      };
      const order =
        operation === 'create'
          ? null
          : await readyOrder({
              customerSeq: customer,
              paymentMethodType: 'groupBilling',
              parcels: [parcel],
            });
      const original = customers.find;
      let unlock, reached;
      const gate = new Promise((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise((resolve) => {
        reached = resolve;
      });
      customers.find = async function (id, client) {
        const result = await original.call(this, id, client);
        if (id === customer && client) {
          reached(client.processID);
          await gate;
        }
        return result;
      };
      let pendingOrder, pendingMember;
      try {
        pendingOrder =
          operation === 'create'
            ? create({ customerSeq: customer, parcels: [parcel] })
            : operation === 'submit'
              ? submitOrder(order)
              : fetch(hosts[0] + '/api/orders/' + order.orderSeq, {
                  method: 'PATCH',
                  headers: {
                    Origin: origin,
                    Cookie: cookies[0],
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({ expectedVersion: order.version, parcels: [parcel] }),
                });
        const pid = await locked;
        if (operation === 'update') {
          pendingMember = fetch(hosts[1] + '/api/companies/' + organizationId + '/members', {
            method: 'POST',
            headers: { Origin: origin, Cookie: cookies[1], 'Content-Type': 'application/json' },
            body: JSON.stringify({
              items: [
                { employeeNo, name: '변경 고객', phoneNumber: phone, departmentSeq: department },
              ],
            }),
          });
        } else {
          pendingMember = fetch(hosts[1] + '/api/members/' + membership, {
            method: 'PATCH',
            headers: { Origin: origin, Cookie: cookies[1], 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ACTIVE' }),
          });
        }
        await waitForBlockedBy(pid);
        unlock();
        const [orderResponse, memberResponse] = await Promise.all([pendingOrder, pendingMember]);
        assert.equal(orderResponse.status, operation === 'create' ? 201 : 200);
        assert.equal(memberResponse.status, 204);
        assert.equal(dverRequests.length, operation === 'submit' ? 1 : 0);
        if (operation === 'submit') {
          assert.equal((await submitOrder(order)).status, 200);
          assert.equal(dverRequests.length, 1);
        }
      } finally {
        unlock();
        await Promise.allSettled([pendingOrder, pendingMember]);
        customers.find = original;
      }
    },
  );
}

for (const status of ['ACTIVE', 'INACTIVE']) {
  test(
    'lock ordering resumes AI completion using the committed ' + status + ' membership',
    async () => {
      resetDver();
      const { MembersRepository } = require('../dist/members/members.repository');
      const members = apps[1].get(MembersRepository);
      const { customer, phone } = await readCustomer();
      const membership = (
        await testMembership(pool, {
          customerSeq: customer,
          organizationSeq: organizationId,
          employeeNo: String(customer),
        })
      ).rows[0].membership_seq;
      const original = members.update;
      let unlock, reached;
      const gate = new Promise((resolve) => {
        unlock = resolve;
      });
      const locked = new Promise((resolve) => {
        reached = resolve;
      });
      members.update = async function (id, input, client) {
        if (id === membership) {
          reached(client.processID);
          await gate;
        }
        return original.call(this, id, input, client);
      };
      const input = aiResult('COMPLETE', {
        customerSeq: customer,
        call: {
          providerCallId: randomUUID(),
          incomingAt: new Date().toISOString(),
          callerPhoneNumber: phone,
        },
        paymentMethodType: 'groupBilling',
        parcels: [
          {
            originPin: { scope: 'COMPANY', pinSeq: companyPin },
            origin: address,
            destination: address,
            smallBoxCount: 1,
            itemPrice: 0,
          },
        ],
      });
      const key = randomUUID();
      let pendingOrder, pendingMember;
      try {
        pendingMember = fetch(hosts[1] + '/api/members/' + membership, {
          method: 'PATCH',
          headers: { Origin: origin, Cookie: cookies[1], 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        const pid = await locked;
        pendingOrder = aiCreate(undefined, input, key);
        await waitForBlockedBy(pid);
        assert.equal(dverRequests.length, 0);
        unlock();
        const [orderResponse, memberResponse] = await Promise.all([pendingOrder, pendingMember]);
        assert.equal(memberResponse.status, 204);
        if (status === 'ACTIVE') {
          assert.equal(orderResponse.status, 201);
          assert.equal((await orderResponse.json()).data.status, 'ACCEPTED');
          assert.equal((await aiCreate(undefined, input, key, 1)).status, 201);
          assert.equal(dverRequests.length, 1);
        } else {
          await errorCode(orderResponse, 403, 'FORBIDDEN');
          assert.equal(dverRequests.length, 0);
          assert.equal(
            (await pool.query('SELECT 1 FROM orders WHERE creation_request_id=$1', [key])).rowCount,
            0,
          );
        }
      } finally {
        unlock();
        await Promise.allSettled([pendingOrder, pendingMember]);
        members.update = original;
      }
    },
  );
}

test('lock ordering times out without partial writes or Dver calls and permits a later retry', async () => {
  resetDver();
  const { customer, phone } = await readCustomer();
  const input = aiResult('COMPLETE', {
    customerSeq: customer,
    call: {
      providerCallId: randomUUID(),
      incomingAt: new Date().toISOString(),
      callerPhoneNumber: phone,
    },
  });
  const key = randomUUID();
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT customer_seq FROM customers WHERE customer_seq=$1 FOR UPDATE', [
      customer,
    ]);
    const started = Date.now();
    await errorCode(await aiCreate(undefined, input, key), 409, 'REQUEST_IN_PROGRESS');
    assert.ok(Date.now() - started >= 1500);
    assert.equal(dverRequests.length, 0);
    assert.equal(
      (await pool.query('SELECT 1 FROM orders WHERE creation_request_id=$1', [key])).rowCount,
      0,
    );
    assert.equal(
      (
        await pool.query('SELECT 1 FROM call_sessions WHERE provider_call_id=$1', [
          input.call.providerCallId,
        ])
      ).rowCount,
      0,
    );
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  assert.equal((await aiCreate(undefined, input, key)).status, 201);
  assert.equal(dverRequests.length, 1);
});

const contextCall = () => ({ providerCallId: randomUUID(), incomingAt: new Date().toISOString() });
const startCallContext = (phoneNumber, call, index = 0, extra = {}) =>
  fetch(hosts[index] + '/api/customers/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify({ phoneNumber, call }),
  });

test('call context starts a session before AI reads and cancels an existing order', async () => {
  const { customer, phone } = await readCustomer();
  const orderId = await readOrder(customer, [{}]);
  const before = await counts();
  const response = await startCallContext(phone, contextCall());
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.customer.customerSeq, customer);
  assert.ok(Number.isInteger(data.callSessionSeq) && data.callSessionSeq > 0);
  assert.deepEqual(await counts(), before);
  const headers = aiReadHeaders(data.callSessionSeq);
  const list = await readOrders('', headers);
  assert.equal(list.status, 200);
  assert.deepEqual(
    (await list.json()).data.map((order) => order.orderSeq),
    [orderId],
  );
  const detail = await readDetail(orderId, headers);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.customerSeq, customer);
  const cancelled = await fetch(hosts[0] + `/api/orders/${orderId}/cancel`, {
    method: 'POST',
    headers: { call_session_seq: String(data.callSessionSeq) },
  });
  assert.equal(cancelled.status, 204);
  assert.equal((await (await readDetail(orderId, headers)).json()).data.status, 'CANCELLED');
  const session = (
    await pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [
      data.callSessionSeq,
    ])
  ).rows[0];
  assert.equal(session.order_seq, null);
});

test('call context reuses one session across retries and rejects changed caller or event time', async () => {
  const { phone } = await readCustomer();
  const identity = contextCall();
  const responses = await Promise.all(
    [0, 1, 2].map((index) => startCallContext(phone, identity, index)),
  );
  assert.ok(responses.every((response) => response.status === 200));
  const ids = await Promise.all(
    responses.map(async (response) => (await response.json()).data.callSessionSeq),
  );
  assert.equal(new Set(ids).size, 1);
  const starts = (
    await pool.query(
      "SELECT actor_type,actor_name FROM audit_logs WHERE target_type='CALL_SESSION' AND target_seq=$1 AND action='CALL_STARTED'",
      [ids[0]],
    )
  ).rows;
  assert.deepEqual(starts, [{ actor_type: 'AI', actor_name: 'AI' }]);
  const sameInstant = {
    ...identity,
    incomingAt: new Date(Date.parse(identity.incomingAt) + 9 * 3600000)
      .toISOString()
      .replace('Z', '+09:00'),
  };
  const repeated = await startCallContext(phone, sameInstant);
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).data.callSessionSeq, ids[0]);
  const international = await startCallContext('0082' + phone.slice(1), identity);
  assert.equal(international.status, 200);
  const internationalData = (await international.json()).data;
  assert.equal(internationalData.callSessionSeq, ids[0]);
  assert.equal(internationalData.customer.phoneNumber, phone);
  await errorCode(await startCallContext('01099990000', identity), 409, 'INVALID_STATE');
  await errorCode(
    await startCallContext(phone, {
      ...identity,
      incomingAt: new Date(Date.parse(identity.incomingAt) + 1000).toISOString(),
    }),
    409,
    'INVALID_STATE',
  );
  const stored = (
    await pool.query(
      'SELECT call_session_seq,caller_phone_number,incoming_at,order_seq FROM call_sessions WHERE provider_call_id=$1',
      [identity.providerCallId],
    )
  ).rows;
  assert.equal(stored.length, 1);
  assert.equal(stored[0].call_session_seq, ids[0]);
  assert.equal(stored[0].caller_phone_number, phone);
  assert.equal(stored[0].incoming_at.toISOString(), identity.incomingAt);
  assert.equal(stored[0].order_seq, null);
  const another = await startCallContext(phone, contextCall());
  assert.equal(another.status, 200);
  assert.notEqual((await another.json()).data.callSessionSeq, ids[0]);
});

test('call context preserves customer scope for orders and personal address changes', async () => {
  const { customer, phone } = await readCustomer();
  const other = await readCustomer();
  const otherOrder = await readOrder(other.customer);
  const response = await startCallContext(phone, contextCall());
  assert.equal(response.status, 200);
  const { callSessionSeq } = (await response.json()).data;
  const headers = { 'Content-Type': 'application/json', call_session_seq: String(callSessionSeq) };
  await errorCode(await readDetail(otherOrder, aiReadHeaders(callSessionSeq)), 404, 'NOT_FOUND');
  await errorCode(
    await fetch(hosts[0] + `/api/orders/${otherOrder}/cancel`, { method: 'POST', headers }),
    404,
    'NOT_FOUND',
  );
  const pinResponse = await fetch(hosts[0] + `/api/customers/${customer}/pins`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ label: '통화 주소', addressData: address }),
  });
  assert.equal(pinResponse.status, 201);
  const pinId = (await pinResponse.json()).data.personalPinSeq;
  const changed = await fetch(hosts[0] + `/api/pins/${pinId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ label: '수정 주소' }),
  });
  assert.equal(changed.status, 200);
  const pins = await fetch(hosts[0] + `/api/customers/${customer}/pins`, { headers });
  assert.equal(pins.status, 200);
  assert.equal((await pins.json()).data[0].label, '수정 주소');
  await errorCode(
    await fetch(hosts[0] + `/api/customers/${other.customer}/pins`, { headers }),
    403,
    'FORBIDDEN',
  );
});

test('call context does not register unknown or withdrawn customers and supports registration later', async () => {
  const phone = '01099117733';
  const before = await counts();
  const response = await startCallContext(phone, contextCall());
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.lookupStatus, 'UNREGISTERED');
  assert.equal(data.customer, null);
  assert.ok(data.callSessionSeq > 0);
  assert.deepEqual(await counts(), before);
  await errorCode(await readOrders('', aiReadHeaders(data.callSessionSeq)), 403, 'FORBIDDEN');
  const registered = await fetch(hosts[0] + '/api/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '통화 중 등록', phoneNumber: phone }),
  });
  assert.equal(registered.status, 201);
  const list = await readOrders('', aiReadHeaders(data.callSessionSeq));
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).data, []);
  const withdrawn = await startCallContext('01000000002', contextCall());
  assert.equal(withdrawn.status, 200);
  const withdrawnData = (await withdrawn.json()).data;
  assert.equal(withdrawnData.lookupStatus, 'WITHDRAWN');
  assert.equal(withdrawnData.customer, null);
  assert.ok(withdrawnData.callSessionSeq > 0);
  await errorCode(
    await readOrders('', aiReadHeaders(withdrawnData.callSessionSeq)),
    403,
    'FORBIDDEN',
  );
});

test('call context and every AI order outcome share the same session without changing the result contract', async () => {
  for (const outcome of ['COMPLETE', 'INCOMPLETE', 'CANCELLED']) {
    resetDver();
    const { customer, phone } = await readCustomer();
    const identity = contextCall();
    const initial = await startCallContext(phone, identity);
    assert.equal(initial.status, 200);
    const callSessionSeq = (await initial.json()).data.callSessionSeq;
    const input = aiResult(outcome, {
      customerSeq: customer,
      call: { ...identity, callerPhoneNumber: '+82' + phone.slice(1) },
    });
    const key = randomUUID();
    const result = await aiCreate(undefined, input, key);
    assert.equal(result.status, 201);
    const data = (await result.json()).data;
    assert.equal(data.callSessionSeq, callSessionSeq);
    assert.equal(
      data.status,
      { COMPLETE: 'ACCEPTED', INCOMPLETE: 'COLLECTING', CANCELLED: 'CANCELLED' }[outcome],
    );
    const retried = await aiCreate(undefined, input, key, 1);
    assert.deepEqual((await retried.json()).data, data);
    const contextAgain = await startCallContext(phone, identity, 1);
    assert.equal(contextAgain.status, 200);
    assert.equal((await contextAgain.json()).data.callSessionSeq, callSessionSeq);
    const sessions = (
      await pool.query(
        'SELECT call_session_seq,order_seq FROM call_sessions WHERE provider_call_id=$1',
        [identity.providerCallId],
      )
    ).rows;
    assert.deepEqual(sessions, [{ call_session_seq: callSessionSeq, order_seq: data.orderSeq }]);
    assert.equal(dverRequests.length, outcome === 'COMPLETE' ? 1 : 0);
  }
});

test('call context rejects malformed identities and untrusted cookies without persisting a session', async () => {
  const before = (await pool.query('SELECT count(*) FROM call_sessions')).rows[0].count;
  const identity = contextCall();
  for (const invalid of [
    null,
    [],
    '',
    {},
    { providerCallId: identity.providerCallId },
    { incomingAt: identity.incomingAt },
    { ...identity, providerCallId: '' },
    { ...identity, providerCallId: 'x'.repeat(201) },
    { ...identity, providerCallId: 'call id' },
    { ...identity, providerCallId: 'call\u0000id' },
    { ...identity, incomingAt: '2026-02-30T01:00:00Z' },
    { ...identity, incomingAt: '2026-10-29T01:00:00' },
    { ...identity, incomingAt: null },
    { ...identity, callerPhoneNumber: '01099990000' },
    { ...identity, orderSeq: 1 },
  ])
    await errorCode(await startCallContext('01000000001', invalid), 400, 'INVALID_REQUEST');
  for (const phone of ['12', '0'.repeat(21)])
    await errorCode(await startCallContext(phone, identity), 400, 'INVALID_REQUEST');
  await errorCode(
    await startCallContext('01000000001', identity, 0, {
      Cookie: 'dva_session=expired',
      Origin: origin,
    }),
    401,
    'UNAUTHORIZED',
  );
  await errorCode(
    await startCallContext('01000000001', identity, 0, {
      Origin: 'https://untrusted.invalid',
    }),
    403,
    'FORBIDDEN',
  );
  assert.equal((await pool.query('SELECT count(*) FROM call_sessions')).rows[0].count, before);
});

test('call context rolls back a new session if the customer lookup fails', async () => {
  const { CustomersRepository } = require('../dist/customers/customers.repository');
  const customers = apps[0].get(CustomersRepository);
  const original = customers.context;
  const identity = contextCall();
  customers.context = async function (...args) {
    await original.apply(this, args);
    throw new Error('private-query-data');
  };
  try {
    const response = await startCallContext('01000000001', identity);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.ok(!JSON.stringify(body).includes('private-query-data'));
    assert.equal(body.data, undefined);
  } finally {
    customers.context = original;
  }
  assert.equal(
    (
      await pool.query('SELECT count(*) FROM call_sessions WHERE provider_call_id=$1', [
        identity.providerCallId,
      ])
    ).rows[0].count,
    '0',
  );
});

const screenOrders = (query = {}, headers = {}, index = 0) =>
  fetch(hosts[index] + '/api/admin/orders?' + new URLSearchParams(query), {
    headers: { Cookie: cookies[index], ...headers },
  });

test('admin screen lists one row per stored order and all saved parcel parties/items with matching totals', async () => {
  const { customer } = await readCustomer();
  const marker = 'screen' + randomUUID();
  const parcels = [
    {
      origin: {
        name: marker + ' 발송인',
        phoneNumber: '01098765432',
        roadAddress: '출발 도로',
        jibunAddress: '출발 지번',
        detailAddress: '101호',
      },
      destination: { name: '첫 수령인', roadAddress: '첫 도착지' },
      documentCount: 1,
    },
    {
      origin: { name: '둘째 발송인' },
      destination: {
        name: marker + ' 두번째 한글',
        roadAddress: marker + ' 도로_%',
        phoneNumber: '01098765433',
      },
      smallBoxCount: 2,
      otherItemDescription: '기타 물품',
    },
  ];
  const id = await readOrder(customer, parcels);
  const emptyId = await readOrder(customer);
  await pool.query(
    "UPDATE orders SET created_at='2091-01-01T00:00:00Z' WHERE order_seq=ANY($1::int[])",
    [[id, emptyId]],
  );
  const range = { from: '2091-01-01T00:00:00Z', to: '2091-01-02T00:00:00Z' };
  const response = await screenOrders({ ...range, limit: '1' });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const first = await response.json();
  assert.deepEqual(Object.keys(first).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(first.total_count, 2);
  assert.equal(first.hasNext, true);
  assert.equal(first.data[0].orderSeq, emptyId);
  assert.deepEqual(first.data[0].parcels, []);
  const second = await (await screenOrders({ ...range, limit: '1', offset: '1' })).json();
  assert.equal(second.total_count, 2);
  assert.equal(second.hasNext, false);
  const row = second.data[0];
  assert.deepEqual(Object.keys(row).sort(), [
    'createdAt',
    'orderSeq',
    'parcels',
    'pickupRequestedAt',
    'status',
  ]);
  assert.equal(row.orderSeq, id);
  assert.equal(row.parcels.length, 2);
  assert.equal(row.parcels[0].origin.name, parcels[0].origin.name);
  assert.equal(row.parcels[1].destination.name, parcels[1].destination.name);
  assert.equal(row.parcels[1].smallBoxCount, 2);
  for (const parcel of row.parcels) {
    assert.deepEqual(Object.keys(parcel).sort(), [
      'bigBoxCount',
      'destination',
      'documentCount',
      'mediumBoxCount',
      'orderParcelSeq',
      'origin',
      'otherItemDescription',
      'smallBoxCount',
      'status',
    ]);
    assert.deepEqual(Object.keys(parcel.origin).sort(), [
      'detailAddress',
      'jibunAddress',
      'name',
      'phoneNumber',
      'roadAddress',
    ]);
  }
  for (const q of [marker.toUpperCase() + ' 두번째 한글', marker + ' 도로_%', '010-9876-5433']) {
    const found = await (await screenOrders({ ...range, q })).json();
    assert.equal(found.total_count, 1);
    assert.deepEqual(
      found.data.map((o) => o.orderSeq),
      [id],
    );
    assert.equal(found.data[0].parcels.length, 2);
  }
  assert.deepEqual(await (await screenOrders({ ...range, offset: '100' })).json(), {
    data: [],
    hasNext: false,
    total_count: 2,
  });
  assert.deepEqual(await (await screenOrders({ ...range, q: "' OR 1=1 --" })).json(), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
  for (let index = 0; index < 3; index++)
    assert.equal((await screenOrders(range, {}, index)).status, 200);
});

test('admin screen tabs group payment-complete states and retain actual receipt statuses', async () => {
  const { customer } = await readCustomer();
  const states = [
    'COLLECTING',
    'notPaid',
    'PAID',
    'SUBMITTING',
    'ACCEPTED',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ];
  for (const status of states) {
    const id = await readOrder(customer, [
      { origin: address, destination: address, documentCount: 1, notifiedPrice: 1000 },
    ]);
    await pool.query(
      `UPDATE orders SET status=$2,total_amount=1000,created_at='2092-01-01T00:00:00Z',pickup_requested_at='2092-01-02T00:00:00Z',
      parcel_no=CASE WHEN $2='ACCEPTED' THEN 'SCRN0058' END,
      dver_received_at=CASE WHEN $2='ACCEPTED' THEN '2092-01-01T00:00:00Z'::timestamptz END WHERE order_seq=$1`,
      [id, status],
    );
  }
  for (const statusGroup of ['COLLECTING', 'notPaid', 'PAID', 'SUBMISSION_FAILED', 'CANCELLED']) {
    const body = await (
      await screenOrders({ from: '2092-01-01T00:00:00Z', to: '2092-01-02T00:00:00Z', statusGroup })
    ).json();
    const expected = statusGroup === 'PAID' ? ['PAID', 'SUBMITTING', 'ACCEPTED'] : [statusGroup];
    assert.equal(body.total_count, expected.length);
    assert.ok(body.data.every((order) => order.parcels.length === 1));
    assert.deepEqual(body.data.map((o) => o.status).sort(), expected.sort());
  }
});

test('admin screen rejects AI access, invalid sessions and malformed query values and documents its exact projection', async () => {
  for (const headers of [
    { Cookie: '' },
    { Cookie: '', call_session_seq: '1' },
    { Cookie: 'dva_session=invalid' },
  ])
    await errorCode(await screenOrders({}, headers), 401, 'UNAUTHORIZED');
  for (const query of [
    { statusGroup: 'SUBMITTING' },
    { status: 'PAID' },
    { customerSeq: '1' },
    { limit: '0' },
    { offset: '-1' },
    { from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
    { from: '2026-01-01' },
    { q: 'x'.repeat(201) },
  ])
    await errorCode(await screenOrders(query), 400, 'INVALID_REQUEST');
  const document = await (await fetch(hosts[0] + '/api/docs-json')).json();
  const operation = document.paths['/api/admin/orders'].get;
  assert.deepEqual(operation.security, [{ adminSession: [] }]);
  assert.equal(
    operation.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/AdminOrderListResponseDto',
  );
  assert.deepEqual(
    Object.keys(document.components.schemas.AdminOrderListItemDto.properties).sort(),
    ['createdAt', 'orderSeq', 'parcels', 'pickupRequestedAt', 'status'],
  );
});

// Admin order edits: all states retain receipt/payment facts; fees follow active details.
test('admins edit, append and remove details in all seven states and derive the total', async () => {
  resetDver();
  for (const [index, status] of [
    'COLLECTING',
    'notPaid',
    'PAID',
    'SUBMITTING',
    'ACCEPTED',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ].entries()) {
    const order = await readyOrder({
      paymentMethodType: 'billing',
      parcels: [
        { origin: address, destination: address, documentCount: 1, notifiedPrice: 2500 },
        { origin: address, destination: address, smallBoxCount: 1, notifiedPrice: 3500 },
      ],
    });
    await pool.query(
      "UPDATE orders SET status=$2,parcel_no=$3,dver_received_at=$4,paid_at=$5,payment_due_at=CASE WHEN $2='notPaid' THEN clock_timestamp()+interval '1 day' ELSE NULL END,created_at='2001-01-01T00:00:00Z' WHERE order_seq=$1",
      [
        order.orderSeq,
        status,
        status === 'ACCEPTED' ? 'ADM00030' : null,
        status === 'ACCEPTED' ? '2026-10-30T00:00:00Z' : null,
        ['COLLECTING', 'notPaid', 'CANCELLED'].includes(status) ? null : '2026-10-30T00:00:00Z',
      ],
    );
    const before = await storedOrder(order.orderSeq);
    const first = before.parcels[0],
      removed = before.parcels[1];
    const response = await patchOrder(
      order.orderSeq,
      {
        expectedVersion: before.version,
        parcels: [
          {
            orderParcelSeq: first.orderParcelSeq,
            destination: { name: '관리자 수정' },
            notifiedPrice: 3000,
          },
          { origin: address, destination: address, mediumBoxCount: 1, notifiedPrice: 4000 },
        ],
        removeParcelSeqs: [removed.orderParcelSeq],
      },
      {},
      index % 3,
    );
    assert.equal(response.status, 200, status + ': ' + (await response.clone().text()));
    const after = await storedOrder(order.orderSeq);
    assert.equal(after.status, status);
    assert.equal(after.paymentMethodType, before.paymentMethodType);
    assert.equal(after.paidAt, before.paidAt);
    assert.equal(after.parcelNo, before.parcelNo);
    assert.equal(after.dverReceivedAt, before.dverReceivedAt);
    assert.equal(after.parcels.length, 3);
    assert.equal(after.parcels[0].destination.name, '관리자 수정');
    assert.equal(after.parcels[1].status, 'CANCELLED');
    assert.deepEqual({ ...after.parcels[1], status: removed.status }, removed);
    assert.equal(after.totalAmount, status === 'CANCELLED' ? 0 : 7000);
    assert.equal(after.parcels[2].status, status === 'CANCELLED' ? 'CANCELLED' : 'ACTIVE');
    assert.equal((await response.json()).data.version, after.version);
    assert.ok(after.version > before.version);
    await errorCode(
      await patchOrder(order.orderSeq, {
        expectedVersion: before.version,
        removeParcelSeqs: [removed.orderParcelSeq],
      }),
      409,
      'VERSION_CONFLICT',
    );
  }
  assert.equal(dverRequests.length, 0);
});

test('admin waiting-payment changes replace only changed amounts and keep the original expiry', async () => {
  const order = await readyOrder({ paymentMethodType: 'billing' });
  await pool.query(
    "UPDATE orders SET status='notPaid',payment_due_at=clock_timestamp()+interval '1 day' WHERE order_seq=$1",
    [order.orderSeq],
  );
  const request = (
    await pool.query(
      'INSERT INTO order_payment_requests(order_seq,amount,expires_at) SELECT order_seq,total_amount,payment_due_at FROM orders WHERE order_seq=$1 RETURNING *',
      [order.orderSeq],
    )
  ).rows[0];
  let before = await storedOrder(order.orderSeq);
  assert.equal(
    (
      await patchOrder(order.orderSeq, {
        expectedVersion: before.version,
        parcels: [
          {
            orderParcelSeq: before.parcels[0].orderParcelSeq,
            destination: { name: '주소만 변경' },
          },
        ],
      })
    ).status,
    200,
  );
  let after = await storedOrder(order.orderSeq);
  assert.equal(after.paymentRequest.paymentRequestId, request.payment_request_id);
  assert.equal(
    (
      await patchOrder(order.orderSeq, {
        expectedVersion: after.version,
        parcels: [{ orderParcelSeq: after.parcels[0].orderParcelSeq, notifiedPrice: 5000 }],
      })
    ).status,
    200,
  );
  after = await storedOrder(order.orderSeq);
  assert.equal(after.totalAmount, 5000);
  assert.equal(after.paymentRequest.amount, 5000);
  assert.notEqual(after.paymentRequest.paymentRequestId, request.payment_request_id);
  assert.equal(Date.parse(after.paymentRequest.expiresAt), request.expires_at.getTime());
  assert.ok(
    (
      await pool.query(
        'SELECT invalidated_at FROM order_payment_requests WHERE payment_request_id=$1',
        [request.payment_request_id],
      )
    ).rows[0].invalidated_at,
  );
  await pool.query(
    'UPDATE order_payment_requests SET approval_started_at=clock_timestamp() WHERE payment_request_id=$1',
    [after.paymentRequest.paymentRequestId],
  );
  before = await storedOrder(order.orderSeq);
  await errorCode(
    await patchOrder(order.orderSeq, {
      expectedVersion: before.version,
      removeParcelSeqs: [before.parcels[0].orderParcelSeq],
    }),
    409,
    'REQUEST_IN_PROGRESS',
  );
  assert.deepEqual(await storedOrder(order.orderSeq), before);
  await pool.query(
    'UPDATE order_payment_requests SET approval_started_at=NULL WHERE payment_request_id=$1',
    [after.paymentRequest.paymentRequestId],
  );
  assert.equal(
    (
      await patchOrder(order.orderSeq, {
        expectedVersion: before.version,
        removeParcelSeqs: [before.parcels[0].orderParcelSeq],
      })
    ).status,
    200,
  );
  after = await storedOrder(order.orderSeq);
  assert.equal(after.status, 'notPaid');
  assert.equal(after.totalAmount, 0);
  assert.equal(after.paymentRequest, null);
});

test('admin edits reject fee overflow, finalized missing fees and a mismatching caller total atomically', async () => {
  const order = await readyOrder({ paymentMethodType: 'billing' });
  await pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.orderSeq]);
  const before = await storedOrder(order.orderSeq);
  for (const change of [
    { parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, notifiedPrice: null }] },
    { parcels: [{ notifiedPrice: 2147483647 }] },
    {
      totalAmount: 4000,
      parcels: [{ orderParcelSeq: before.parcels[0].orderParcelSeq, notifiedPrice: 5000 }],
    },
  ]) {
    await errorCode(
      await patchOrder(order.orderSeq, { expectedVersion: before.version, ...change }),
      422,
      'VALIDATION_FAILED',
    );
    assert.deepEqual(await storedOrder(order.orderSeq), before);
  }
  await errorCode(
    await patchOrder(order.orderSeq, {
      expectedVersion: before.version,
      paymentMethodType: 'credit',
    }),
    409,
    'INVALID_STATE',
  );
  assert.deepEqual(await storedOrder(order.orderSeq), before);
});

test('admin detail removals preserve same-order scope and rollback fees, details, requests and audit on failure', async () => {
  const order = await readyOrder({ paymentMethodType: 'billing' }),
    foreign = await storedOrder((await readyOrder()).orderSeq);
  const before = await storedOrder(order.orderSeq);
  for (const id of [foreign.parcels[0].orderParcelSeq, 2147483647]) {
    await errorCode(
      await patchOrder(order.orderSeq, {
        expectedVersion: before.version,
        parcels: [{ notifiedPrice: 7000 }],
        removeParcelSeqs: [id],
      }),
      404,
      'NOT_FOUND',
    );
    assert.deepEqual(await storedOrder(order.orderSeq), before);
  }
  const audit = apps[0].get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (...args) {
    if (args[0].action === 'ORDER_UPDATED') throw Error('admin-edit-rollback');
    return original.apply(this, args);
  };
  const audits = (
    await pool.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND result='SUCCESS'",
      [order.orderSeq],
    )
  ).rows[0].n;
  try {
    assert.equal(
      (
        await patchOrder(order.orderSeq, {
          expectedVersion: before.version,
          parcels: [{ notifiedPrice: 7000 }],
          removeParcelSeqs: [before.parcels[0].orderParcelSeq],
        })
      ).status,
      500,
    );
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual(await storedOrder(order.orderSeq), before);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='ORDER' AND target_seq=$1 AND result='SUCCESS'",
        [order.orderSeq],
      )
    ).rows[0].n,
    audits,
  );
});

test('AI cannot use admin removals and admin database permission never survives its transaction', async () => {
  const order = await readyOrder({ paymentMethodType: 'billing' }),
    before = await storedOrder(order.orderSeq),
    callId = await call('01000000003');
  await errorCode(
    await patchOrder(
      order.orderSeq,
      { expectedVersion: before.version, removeParcelSeqs: [before.parcels[0].orderParcelSeq] },
      aiReadHeaders(callId),
    ),
    403,
    'FORBIDDEN',
  );
  assert.deepEqual(await storedOrder(order.orderSeq), before);
  await pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.orderSeq]);
  let detail = await storedOrder(order.orderSeq);
  const sql = 'UPDATE order_parcels SET client_comment=$2 WHERE order_parcel_seq=$1';
  await assert.rejects(
    () => pool.query(sql, [detail.parcels[0].orderParcelSeq, 'raw write forbidden']),
    { code: '23514' },
  );
  assert.equal(
    (
      await patchOrder(order.orderSeq, {
        expectedVersion: detail.version,
        parcels: [
          { orderParcelSeq: detail.parcels[0].orderParcelSeq, clientComment: 'admin saved' },
        ],
      })
    ).status,
    200,
  );
  await assert.rejects(
    () => pool.query(sql, [detail.parcels[0].orderParcelSeq, 'raw write still forbidden']),
    { code: '23514' },
  );
  detail = await storedOrder(order.orderSeq);
  assert.equal(detail.parcels[0].clientComment, 'admin saved');
});

test('concurrent admin edits of a finalized order have one winner and retain amount consistency', async () => {
  const order = await readyOrder({ paymentMethodType: 'billing' });
  await pool.query("UPDATE orders SET status='PAID' WHERE order_seq=$1", [order.orderSeq]);
  const before = await storedOrder(order.orderSeq);
  const responses = await Promise.all(
    [0, 1].map((index) =>
      patchOrder(
        order.orderSeq,
        {
          expectedVersion: before.version,
          parcels: [
            {
              orderParcelSeq: before.parcels[0].orderParcelSeq,
              notifiedPrice: 4000 + index * 1000,
            },
          ],
        },
        {},
        index,
      ),
    ),
  );
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const after = await storedOrder(order.orderSeq);
  assert.equal(after.totalAmount, after.parcels[0].notifiedPrice);
  assert.equal(after.status, 'PAID');
});
