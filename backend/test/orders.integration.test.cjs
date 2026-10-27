require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const { AuditService } = require('../dist/audit/audit.service');
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upgraded = (
      await client.query(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='orders' AND column_name='creation_request_id') AS ready",
      )
    ).rows[0].ready;
    const migrations = upgraded
      ? []
      : [
          ['public.admin_users', '002-monolith-initial.sql'],
          ['public.admin_sessions', '003-admin-auth-sessions.sql'],
          ['api_idempotency.organization_creations', '004-organization-creation-requests.sql'],
          ['api_idempotency.customer_creations', '005-customer-creation-requests.sql'],
          ['api_idempotency.order_creations', '007-order-creation-requests.sql'],
        ];
    for (const [table, file] of migrations) {
      if (!(await client.query('SELECT to_regclass($1) AS present', [table])).rows[0].present)
        await client.query(readFileSync(join(__dirname, '../migrations', file), 'utf8'));
    }
    if (!upgraded)
      await client.query(
        readFileSync(join(__dirname, '../migrations/008-simplify-creation-requests.sql'), 'utf8'),
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const hash = await hashPassword(password);
  for (const [index, role] of ['OPERATOR', 'SYSTEM_ADMIN', 'SUPERVISOR'].entries()) {
    const result = await pool.query(
      `INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'주문 검증',$2,$3,'ACTIVE') RETURNING admin_user_seq`,
      [`orderTest${index}`, hash, role],
    );
    if (index === 0) adminId = result.rows[0].admin_user_seq;
    const app = await NestFactory.create(AppModule, { logger: false });
    apps.push(app);
    configureApplication(app, { log: () => {} });
    await app.listen(0, '127.0.0.1');
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
  await pool.query(
    "INSERT INTO memberships(customer_seq,organization_seq,employee_no,status) VALUES($1,$2,'order-test','ACTIVE')",
    [customerId, organizationId],
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
});
after(async () => {
  for (const app of apps) await app.close();
  await pool.end();
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
    'X-Call-Session-Id': callId === undefined ? undefined : String(callId),
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
  const unchanged = await aiCreate(callId, { ...body, paymentMethodType: 'cat' }, key);
  assert.equal(unchanged.status, 201);
  assert.deepEqual((await unchanged.json()).data, data);
  assert.equal(
    (await pool.query('SELECT payment_method_type FROM orders WHERE order_seq=$1', [data.orderSeq]))
      .rows[0].payment_method_type,
    'credit',
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
      payment_method_type: 'credit',
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

test('partial parcel snapshots retain field mapping, defaults and the actual trigger-updated version', async () => {
  const response = await create({
    customerSeq: customerId,
    paymentMethodType: 'cat',
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
  assert.ok(rows.every((row) => row.notified_price === 3500));
  const header = (
    await pool.query('SELECT version,pickup_requested_at FROM orders WHERE order_seq=$1', [
      data.orderSeq,
    ])
  ).rows[0];
  assert.equal(header.pickup_requested_at.toISOString(), '2026-10-28T01:00:00.000Z');
  assert.equal(data.version, header.version);
  assert.equal(data.version, 3);
});

test('invalid bodies and keys fail before order writes', async () => {
  const before = await counts();
  for (const body of [
    { customerSeq: '1' },
    { customerSeq: customerId, parcels: [{ origin: { extra: 1 } }] },
    { customerSeq: customerId, parcels: [{ notifiedPrice: 1 }] },
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
      'X-Call-Session-Id': String(callId),
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
    paymentMethodType: 'cat',
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

test('Swagger advertises session authentication, exclusive customer inputs, UUID key and the real response envelope', async () => {
  const response = await fetch(hosts[0] + '/api/docs-json');
  assert.equal(response.status, 200);
  const spec = await response.json(),
    operation = spec.paths['/api/orders'].post;
  assert.deepEqual(operation.security, [{ adminSession: [] }, {}]);
  const callHeaders = operation.parameters.filter(
    (p) => p.in === 'header' && p.name.toLowerCase() === 'x-call-session-id',
  );
  assert.equal(callHeaders.length, 1);
  assert.equal(callHeaders[0].name, 'X-Call-Session-Id');
  assert.equal(callHeaders[0].required, false);
  assert.equal(callHeaders[0].schema.type, 'integer');
  assert.equal(callHeaders[0].schema.minimum, 1);
  assert.equal(callHeaders[0].schema.maximum, 2147483647);
  assert.equal(spec.paths['/api/orders/validation'], undefined);
  assert.equal(spec.paths['/api/consultations/incomplete'], undefined);
  assert.equal(spec.paths['/api/consultations/incomplete/{id}'], undefined);
  assert.ok(operation.parameters.some((p) => p.name === 'Idempotency-Key' && p.required));
  assert.ok(!operation.parameters.some((p) => p.name === 'X-CSRF-Protection'));
  const inputSchema = operation.requestBody.content['application/json'].schema;
  const examples = operation.requestBody.content['application/json'].examples;
  assert.equal(examples.existingCustomer.value.customer, undefined);
  assert.equal(examples.customerByPhone.value.customerSeq, undefined);
  assert.equal(typeof examples.customerByPhone.value.customer.phoneNumber, 'string');
  assert.deepEqual(inputSchema.oneOf, [{ required: ['customerSeq'] }, { required: ['customer'] }]);
  assert.equal(inputSchema.allOf[0].$ref, '#/components/schemas/CreateOrderDto');
  assert.deepEqual(spec.components.schemas.OrderCustomerDto.required.sort(), [
    'name',
    'phoneNumber',
  ]);
  assert.ok(!(spec.components.schemas.CreateOrderDto.required ?? []).includes('customerSeq'));
  const schema = operation.responses['201'].content['application/json'].schema;
  assert.deepEqual(schema.required, ['data', 'meta']);
  assert.equal(
    spec.components.schemas.CreateOrderDto.properties.parcels.items.$ref,
    '#/components/schemas/ParcelInputDto',
  );
  assert.equal(
    spec.components.schemas.ParcelInputDto.properties.origin.allOf[0].$ref,
    '#/components/schemas/OrderAddressPatchDto',
  );
});

let readPhone = 580000;
const readCustomer = async () => {
  const phone = '010' + String(++readPhone).padStart(8, '0');
  const customer = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('조회 고객',$1,'ACTIVE') RETURNING customer_seq",
      [phone],
    )
  ).rows[0].customer_seq;
  return { customer, phone };
};
const readOrder = async (customer, parcels = []) => {
  const response = await create({ customerSeq: customer, parcels });
  assert.equal(response.status, 201);
  return (await response.json()).data.orderSeq;
};
const readOrders = (query = '', extra = {}, index = 0) =>
  fetch(hosts[index] + '/api/orders' + query, {
    headers: Object.fromEntries(
      Object.entries({ Cookie: cookies[index], ...extra }).filter(([, v]) => v !== undefined),
    ),
  });
const aiReadHeaders = (callId) => ({ Cookie: undefined, 'X-Call-Session-Id': String(callId) });

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
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
  assert.equal(body.hasNext, true);
  assert.deepEqual(
    body.data.map((o) => o.orderSeq),
    [ids[2], ids[1]],
  );
  assert.deepEqual(
    body.data.map((o) => o.parcelCount),
    [2, 1],
  );
  assert.deepEqual(body.data[0].shipmentStatuses, []);
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
    shipmentStatus: 'sent',
    recipientName: 'alice_100%',
  });
  const response = await readOrders('?' + filters);
  assert.equal(response.status, 200);
  const { data, hasNext } = await response.json();
  assert.equal(hasNext, false);
  assert.equal(data.length, 1);
  assert.equal(data[0].orderSeq, selected);
  assert.equal(data[0].parcelCount, 3);
  assert.deepEqual(data[0].shipmentStatuses, ['paid', 'sent']);
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
    (await (await readOrders(`?customerSeq=${customer}&shipmentStatus=canceled`)).json()).data,
    [],
  );
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
  await pool.query(
    "INSERT INTO memberships(customer_seq,organization_seq,employee_no,status) VALUES($1,$2,'read-other','ACTIVE')",
    [otherId, organizationId],
  );
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
    '?recipientName=',
    '?unknown=1',
  ])
    await errorCode(await readOrders(query), 400, 'INVALID_REQUEST');
  for (const callId of [undefined, '', 'abc', '0', '-1', '2147483648', '1,2']) {
    await errorCode(
      await readOrders('', { Cookie: undefined, 'X-Call-Session-Id': callId }),
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

test('ORD-02 Swagger describes filters, a single call header and the actual list envelope', async () => {
  const spec = await (await fetch(hosts[0] + '/api/docs-json')).json();
  const operation = spec.paths['/api/orders'].get;
  assert.ok(operation.summary.includes('ORD-02'));
  assert.ok(operation.description.includes('AI'));
  const headers = operation.parameters.filter((p) => p.in === 'header');
  assert.deepEqual(
    headers.map((p) => p.name),
    ['X-Call-Session-Id'],
  );
  assert.equal(headers[0].schema.type, 'integer');
  const queries = operation.parameters.filter((p) => p.in === 'query');
  assert.deepEqual(queries.map((p) => p.name).sort(), [
    'customerSeq',
    'from',
    'limit',
    'offset',
    'recipientName',
    'shipmentStatus',
    'status',
    'to',
  ]);
  assert.ok(queries.every((p) => p.description && !p.required));
  assert.deepEqual(operation.responses[200].content['application/json'].schema.required, [
    'data',
    'hasNext',
  ]);
  assert.ok(
    Object.values(spec.components.schemas.OrderSummaryDto.properties).every((p) => p.description),
  );
});
