const { testMembership } = require('./helpers/membership.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestSession, createTestPool, startTestApp } = require('./helpers/application.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'false';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { OrdersRepository } = require('../dist/orders/orders.repository');

const pool = createTestPool();
const apps = [];
const addressFields = [
  'name',
  'phoneNumber',
  'roadAddress',
  'jibunAddress',
  'detailAddress',
  'dongName',
  'postalCode',
];
const sqlFields = [
  'name',
  'phone_number',
  'road_address',
  'jibun_address',
  'detail_address',
  'dong_name',
  'postal_code',
];
const address = (prefix = '도착', extra = {}) => ({
  name: prefix + ' 수령인',
  phoneNumber: '01001234567',
  roadAddress: prefix + '로 12',
  jibunAddress: prefix + '동 12',
  detailAddress: '101호',
  dongName: prefix + '동',
  postalCode: '01234',
  ...extra,
});
let app, base, adminHeaders;
const logs = [];
async function request(customerId, query = { direction: 'DESTINATION' }, headers = adminHeaders) {
  const search = typeof query === 'string' ? query : new URLSearchParams(query).toString();
  return fetch(base + `/api/customers/${customerId}/addresses?${search}`, {
    headers,
    signal: AbortSignal.timeout(10000),
  });
}
async function result(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
  assert.ok(response.headers.get('x-request-id'));
  return body;
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
}
async function account(role = 'OPERATOR') {
  const loginId = 'history' + randomUUID().replaceAll('-', '').slice(0, 13);
  const { rows } = await pool.query(
    `INSERT INTO admin_users(login_id,name,password_hash,role,status)
    VALUES($1,'이력 관리자',$2,$3,'ACTIVE') RETURNING admin_user_seq`,
    [loginId, 'not-for-login', role],
  );
  return { Cookie: await createTestSession(pool, rows[0].admin_user_seq) };
}
before(async () => {
  // check:docker의 DB·주문 선행 검증이 배포 마이그레이션을 적용한다.
  assert.ok((await pool.query("SELECT to_regclass('public.orders') AS name")).rows[0].name);
  app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
  base = await app.getUrl();
  adminHeaders = await account();
});
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});
async function fixture(status = 'ACTIVE', phone = '010' + String(randomInt(10000000, 100000000))) {
  const customer = (
    await pool.query(
      `INSERT INTO customers(name,phone_number,status)
    VALUES('이력 고객',$1,$2) RETURNING customer_seq`,
      [phone, status],
    )
  ).rows[0].customer_seq;
  const call = (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number)
    VALUES($1,$2) RETURNING call_session_seq`,
      [randomUUID(), phone],
    )
  ).rows[0].call_session_seq;
  return { customer, call, phone, ai: { call_session_seq: String(call) } };
}
async function order(
  f,
  {
    status = 'ACCEPTED',
    createdAt = '2026-10-20T01:00:00Z',
    receivedAt = '2026-10-25T01:00:00Z',
    parcels = [{}],
  } = {},
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = (
      await client.query(
        `INSERT INTO orders(customer_seq,created_at,payment_method_type,pickup_requested_at)
      VALUES($1,$2,'billing','2026-12-01T00:00:00Z') RETURNING order_seq`,
        [f.customer, createdAt],
      )
    ).rows[0].order_seq;
    const details = [];
    for (const [i, parcel] of parcels.entries()) {
      const origin = parcel.origin ?? address('출발'),
        destination = parcel.destination ?? address();
      const names = ['origin', 'destination'].flatMap((side) =>
        sqlFields.map((field) => side + '_' + field),
      );
      const values = [
        id,
        i + 1,
        ...addressFields.map((key) => origin[key] ?? null),
        ...addressFields.map((key) => destination[key] ?? null),
      ];
      const row = (
        await client.query(
          `INSERT INTO order_parcels(order_seq,parcel_position,${names.join(',')})
        VALUES(${values.map((_, n) => '$' + (n + 1)).join(',')}) RETURNING order_parcel_seq`,
          values,
        )
      ).rows[0];
      details.push({ orderParcelSeq: row.order_parcel_seq, origin, destination });
    }
    await client.query(
      `UPDATE orders SET status=$2,parcel_no=$3,dver_received_at=$4 WHERE order_seq=$1`,
      [
        id,
        status,
        status === 'ACCEPTED' ? randomUUID().replaceAll('-', '').slice(0, 8) : null,
        status === 'ACCEPTED' ? receivedAt : null,
      ],
    );
    await client.query('COMMIT');
    return { orderSeq: id, details, createdAt: new Date(createdAt).toISOString() };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

test('only ACCEPTED orders yield snapshots, even when no PIN was saved', async () => {
  const f = await fixture();
  const accepted = await order(f);
  for (const status of [
    'COLLECTING',
    'notPaid',
    'PAID',
    'SUBMITTING',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ])
    await order(f, { status });
  const body = await result(await request(f.customer, { direction: 'DESTINATION' }, f.ai));
  assert.deepEqual(body, {
    data: [
      {
        orderSeq: accepted.orderSeq,
        orderParcelSeq: accepted.details[0].orderParcelSeq,
        createdAt: accepted.createdAt,
        address: accepted.details[0].destination,
      },
    ],
    hasNext: false,
    total_count: 1,
  });
  assert.equal(
    (await pool.query('SELECT count(*) FROM personal_pins WHERE customer_seq=$1', [f.customer]))
      .rows[0].count,
    '0',
  );
});

test('direction selects the historical source without mixing origin, destination or current PIN data', async () => {
  const f = await fixture();
  const o = await order(f);
  await pool.query('INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2)', [
    f.customer,
    address('현재 주소'),
  ]);
  for (const direction of ['ORIGIN', 'DESTINATION']) {
    const body = await result(await request(f.customer, { direction }, f.ai));
    assert.deepEqual(
      body.data[0].address,
      direction === 'ORIGIN' ? o.details[0].origin : o.details[0].destination,
    );
  }
  await pool.query(
    "UPDATE personal_pins SET label='수정된 별칭',address_data=$2 WHERE customer_seq=$1",
    [f.customer, address('변경 주소')],
  );
  assert.deepEqual(
    (await result(await request(f.customer))).data[0].address,
    o.details[0].destination,
  );
});

test('time range uses order creation, includes from and excludes to with equivalent KST/UTC boundaries', async () => {
  const f = await fixture();
  const start = '2026-10-18T15:00:00Z',
    end = '2026-10-25T15:00:00Z';
  await order(f, { createdAt: '2026-10-18T14:59:59Z' });
  const atStart = await order(f, { createdAt: start, receivedAt: '2026-10-27T00:00:00Z' });
  const middle = await order(f, { createdAt: '2026-10-20T00:00:00Z' });
  const atEnd = await order(f, { createdAt: end });
  const query = {
    direction: 'DESTINATION',
    from: '2026-10-19T00:00:00+09:00',
    to: '2026-10-26T00:00:00+09:00',
  };
  const body = await result(await request(f.customer, query, f.ai));
  assert.deepEqual(
    body.data.map((row) => row.orderSeq),
    [middle.orderSeq, atStart.orderSeq],
  );
  assert.deepEqual(
    await result(await request(f.customer, { ...query, from: start, to: end })),
    body,
  );
  assert.equal(
    (await result(await request(f.customer, { direction: 'ORIGIN', from: end }))).data[0].orderSeq,
    atEnd.orderSeq,
  );
  assert.equal(
    (await result(await request(f.customer, { direction: 'ORIGIN', to: start }))).data.length,
    1,
  );
});

test('search is literal, normalized and restricted to the selected direction', async () => {
  const f = await fixture();
  const destination = address('도착', { name: 'Kim 가나', detailAddress: '100%_101호' });
  const origin = address('출발', { name: '출발 전용' });
  await order(f, { parcels: [{ origin, destination }] });
  for (const q of [' kim ', '가나'.normalize('NFD'), '01001234567', '도착로', '100%_', '01234'])
    assert.equal(
      (await result(await request(f.customer, { direction: 'DESTINATION', q }, f.ai))).data.length,
      1,
      q,
    );
  for (const q of ['출발 전용', "' OR TRUE --", '없는주소'])
    assert.deepEqual(
      await result(await request(f.customer, { direction: 'DESTINATION', q }, f.ai)),
      { data: [], hasNext: false, total_count: 0 },
    );
  assert.equal(
    (await result(await request(f.customer, { direction: 'ORIGIN', q: '출발 전용' }))).data.length,
    1,
  );
  assert.equal(
    (await result(await request(f.customer, { direction: 'DESTINATION', q: '  ' }))).data.length,
    1,
  );
});

test('same address remains separate per order/parcel and stable pagination handles timestamp ties', async () => {
  const f = await fixture();
  const older = await order(f, { parcels: [{}, {}] });
  const newer = await order(f, { parcels: [{}, {}] });
  const all = await result(await request(f.customer));
  assert.deepEqual(
    all.data.map((row) => row.orderParcelSeq),
    [...newer.details, ...older.details].map((p) => p.orderParcelSeq),
  );
  const pages = [];
  for (let offset = 0; offset < 4; offset += 2) {
    const body = await result(
      await request(f.customer, { direction: 'DESTINATION', limit: '2', offset: String(offset) }),
    );
    assert.equal(body.hasNext, offset === 0);
    pages.push(...body.data);
  }
  assert.deepEqual(pages, all.data);
  assert.deepEqual(
    await result(await request(f.customer, { direction: 'DESTINATION', offset: '4' })),
    { data: [], hasNext: false, total_count: 4 },
  );
});

test('active administrator roles can choose a customer and inspect retained withdrawn-customer history', async () => {
  const f = await fixture('WITHDRAWN');
  const o = await order(f);
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const headers = await account(role);
    assert.equal(
      (await result(await request(f.customer, undefined, headers))).data[0].orderSeq,
      o.orderSeq,
    );
    await error(await request(2147483647, undefined, headers), 404, 'NOT_FOUND');
  }
  const empty = await fixture();
  assert.deepEqual(await result(await request(empty.customer)), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
});

test('AI cannot access another customer history, even within the same company', async () => {
  const f = await fixture(),
    other = await fixture();
  await order(f);
  await order(other);
  await error(await request(other.customer, undefined, f.ai), 403, 'FORBIDDEN');
  const org = (
    await pool.query(
      "INSERT INTO organizations(name,status) VALUES('같은 회사','ACTIVE') RETURNING organization_seq",
    )
  ).rows[0].organization_seq;
  for (const c of [f, other])
    await testMembership(pool, {
      customerSeq: c.customer,
      organizationSeq: org,
      employeeNo: randomUUID(),
    });
  await error(await request(other.customer, undefined, f.ai), 403, 'FORBIDDEN');
  assert.equal((await result(await request(f.customer, undefined, f.ai))).data.length, 1);
});

test('AI calls require an existing ongoing call and an ACTIVE customer with matching phone', async () => {
  const f = await fixture();
  for (const header of [undefined, '0', '-1', 'abc', '1.5', '2147483648']) {
    await error(
      await request(
        f.customer,
        undefined,
        header === undefined ? {} : { call_session_seq: header },
      ),
      400,
      'INVALID_REQUEST',
    );
  }
  await error(
    await request(f.customer, undefined, { call_session_seq: '2147483647' }),
    404,
    'NOT_FOUND',
  );
  await pool.query('UPDATE call_sessions SET caller_phone_number=NULL WHERE call_session_seq=$1', [
    f.call,
  ]);
  await error(await request(f.customer, undefined, f.ai), 403, 'FORBIDDEN');
  await pool.query('UPDATE call_sessions SET caller_phone_number=$2 WHERE call_session_seq=$1', [
    f.call,
    f.phone,
  ]);
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [f.customer]);
  await error(await request(f.customer, undefined, f.ai), 403, 'FORBIDDEN');
  const ended = await fixture();
  await pool.query(
    "UPDATE call_sessions SET started_at='2026-10-27T00:00:00Z',ended_at='2026-10-27T00:01:00Z' WHERE call_session_seq=$1",
    [ended.call],
  );
  await error(await request(ended.customer, undefined, ended.ai), 409, 'INVALID_STATE');
});

test('invalid admin cookies never fall back to AI and untrusted Origins remain forbidden', async () => {
  const f = await fixture();
  for (const Cookie of ['dva_session=bad', 'dva_session=' + 'f'.repeat(64)])
    await error(await request(f.customer, undefined, { ...f.ai, Cookie }), 401, 'UNAUTHORIZED');
  await error(
    await request(f.customer, undefined, { ...f.ai, Origin: 'https://untrusted.invalid' }),
    403,
    'FORBIDDEN',
  );
});

test('historical empty addresses are skipped while nullable details are preserved without invention', async () => {
  const f = await fixture();
  await order(f, {
    parcels: [{ destination: address('도착', { roadAddress: null, jibunAddress: '  ' }) }],
  });
  assert.deepEqual(await result(await request(f.customer)), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
  const valid = await order(f, {
    parcels: [{ destination: address('도착', { detailAddress: null }) }],
  });
  const body = await result(await request(f.customer));
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].orderSeq, valid.orderSeq);
  assert.equal(body.data[0].address.detailAddress, null);
  assert.equal(body.data[0].address.postalCode, '01234');
});

test('authorization and address data share one read snapshot during concurrent status/data changes', async () => {
  const f = await fixture();
  const existing = await order(f);
  const repository = app.get(OrdersRepository),
    original = repository.addressHistory;
  let ready, release;
  const entered = new Promise((resolve) => {
    ready = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  repository.addressHistory = async function (...args) {
    ready();
    await gate;
    return original.apply(this, args);
  };
  let pending;
  try {
    pending = request(f.customer, undefined, f.ai);
    await Promise.race([
      entered,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('history gate not reached')), 3000),
      ),
    ]);
    await order(f, { createdAt: '2026-10-21T00:00:00Z' });
    await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [f.customer]);
    release();
    assert.deepEqual(
      (await result(await pending)).data.map((row) => row.orderSeq),
      [existing.orderSeq],
    );
  } finally {
    release();
    repository.addressHistory = original;
    if (pending) await pending;
  }
  await error(await request(f.customer, undefined, f.ai), 403, 'FORBIDDEN');
});

test('history reads are side-effect free and failures are not returned as empty success', async () => {
  const f = await fixture();
  const o = await order(f);
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM orders) AS orders,
    (SELECT count(*) FROM personal_pins) AS pins,(SELECT count(*) FROM audit_logs) AS audits`)
    ).rows[0];
  const before = await counts();
  await result(await request(f.customer, undefined, f.ai));
  await result(await request(f.customer));
  assert.deepEqual(await counts(), before);
  const repository = app.get(OrdersRepository),
    original = repository.addressHistory;
  repository.addressHistory = async () => {
    throw new Error('private database error');
  };
  try {
    await error(await request(f.customer), 500, 'INTERNAL_ERROR');
  } finally {
    repository.addressHistory = original;
  }
  assert.equal((await result(await request(f.customer))).data[0].orderSeq, o.orderSeq);
});
