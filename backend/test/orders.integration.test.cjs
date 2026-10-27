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
    const migrations = [
      ['public.admin_users', '002-monolith-initial.sql'],
      ['public.admin_sessions', '003-admin-auth-sessions.sql'],
      ['api_idempotency.organization_creations', '004-organization-creation-requests.sql'],
      ['api_idempotency.order_creations', '005-order-creation-requests.sql'],
    ];
    for (const [table, file] of migrations) {
      if (!(await client.query('SELECT to_regclass($1) AS present', [table])).rows[0].present)
        await client.query(readFileSync(join(__dirname, '../migrations', file), 'utf8'));
    }
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
  (SELECT count(*) FROM api_idempotency.order_creations) AS receipts,
  (SELECT count(*) FROM shipments) AS shipments`)
  ).rows[0];
const errorCode = async (response, status, code) => {
  assert.equal(response.status, status);
  assert.equal((await response.json()).error.code, code);
};

test('orders require a current administrator session and allowed Origin, without trusting caller headers', async () => {
  const before = await counts();
  for (const Cookie of [undefined, 'dva_session=bad', 'dva_session=' + 'f'.repeat(64)]) {
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

test('idempotency normalizes object order and defaults, preserves the original version and rejects changed input', async () => {
  const key = randomUUID(),
    requestId = randomUUID();
  const first = await create({ customerSeq: customerId }, key, 0, { 'X-Request-Id': requestId });
  assert.equal(first.status, 201);
  const { data } = await first.json();
  await pool.query('UPDATE orders SET version=version+1 WHERE order_seq=$1', [data.orderSeq]);
  const replay = await create(
    { parcels: [], pickupRequestedAt: null, paymentMethodType: 'credit', customerSeq: customerId },
    key.toUpperCase(),
  );
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, data);
  await errorCode(
    await create({ customerSeq: customerId, paymentMethodType: 'cat' }, key),
    422,
    'IDEMPOTENCY_KEY_REUSED',
  );
  const logs = (
    await pool.query(
      "SELECT actor_seq,request_id,metadata FROM audit_logs WHERE action='ORDER_CREATED' AND target_seq=$1 AND result='SUCCESS'",
      [data.orderSeq],
    )
  ).rows;
  assert.equal(logs.length, 1);
  assert.equal(logs[0].actor_seq, adminId);
  assert.equal(logs[0].request_id, requestId);
  assert.deepEqual(logs[0].metadata, {});
  const other = await create({ customerSeq: customerId }, key, 1);
  assert.equal(other.status, 201);
  assert.notEqual((await other.json()).data.orderSeq, data.orderSeq);
});

test('in-flight duplicates across application instances return 409 and retry the stored result', async () => {
  const key = randomUUID(),
    client = await pool.connect();
  await client.query('BEGIN');
  try {
    assert.equal(await repository.lockCreation(client, adminId, key), true);
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
      (
        await pool.query(
          'SELECT count(*) FROM api_idempotency.order_creations WHERE admin_user_seq=$1 AND idempotency_key=$2',
          [adminId, key],
        )
      ).rows[0].count,
      '1',
    );
  } finally {
    cookies[1] = cookieB;
  }
});

test('receipt and success-audit failures roll back header, parcels and receipt while preserving safe failure audit', async () => {
  const audit = apps[0].get(AuditService);
  for (const [target, method] of [
    [repository, 'rememberCreation'],
    [audit, 'recordSuccess'],
  ]) {
    const original = target[method],
      before = await counts(),
      requestId = randomUUID(),
      key = randomUUID();
    target[method] = async () => {
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

test('Swagger advertises session authentication, UUID key, nested DTOs and the real response envelope', async () => {
  const response = await fetch(hosts[0] + '/api/docs-json');
  assert.equal(response.status, 200);
  const spec = await response.json(),
    operation = spec.paths['/api/orders'].post;
  assert.deepEqual(operation.security, [{ adminSession: [] }]);
  assert.ok(operation.parameters.some((p) => p.name === 'Idempotency-Key' && p.required));
  assert.ok(!operation.parameters.some((p) => p.name === 'X-CSRF-Protection'));
  const schema = operation.responses['201'].content['application/json'].schema;
  assert.deepEqual(schema.required, ['data', 'meta']);
  assert.equal(
    spec.components.schemas.CreateOrderDto.properties.parcels.items.$ref,
    '#/components/schemas/ParcelInputDto',
  );
  assert.equal(
    spec.components.schemas.ParcelInputDto.properties.origin.$ref,
    '#/components/schemas/OrderAddressPatchDto',
  );
});
