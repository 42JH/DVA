const { testMembership } = require('./helpers/membership.cjs');
const customerAddress = require('./helpers/customer-address.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { migrate } = require('./helpers/migrations.cjs');
const {
  createTestSession,
  createTestPool,
  startTestApp,
  businessHeaders,
} = require('./helpers/application.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'false';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { CustomersRepository } = require('../dist/customers/customers.repository');

const pool = createTestPool();
const apps = [];
const origin = 'http://localhost:5173';
let app, base, baseB, repository, adminCookie, adminId;
const phone = () => '010' + String(randomInt(10000000, 100000000));
const start = () => startTestApp(apps);
async function account(role = 'OPERATOR') {
  const loginId = 'cus' + randomUUID().replaceAll('-', '').slice(0, 16);
  const { rows } = await pool.query(
    `INSERT INTO admin_users (login_id,name,password_hash,role,status)
     VALUES ($1,'고객 테스트',$2,$3,'ACTIVE') RETURNING admin_user_seq`,
    [loginId, 'not-for-login', role],
  );
  return {
    id: rows[0].admin_user_seq,
    cookie: await createTestSession(pool, rows[0].admin_user_seq),
  };
}
before(async () => {
  await migrate(pool);
  app = await start();
  base = await app.getUrl();
  baseB = await (await start()).getUrl();
  const admin = await account();
  adminCookie = admin.cookie;
  adminId = admin.id;
  repository = app.get(CustomersRepository);
});
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});

function request(path = '', options = {}, host = base) {
  return fetch(host + '/api/customers' + path, {
    ...options,
    headers: Object.fromEntries(
      Object.entries({ ...businessHeaders(), ...options.headers }).filter(
        ([, v]) => v !== undefined,
      ),
    ),
  });
}
function create(
  input = { name: '고객', phoneNumber: phone() },
  key = undefined,
  host = base,
  headers = {},
) {
  return request(
    '',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
        ...headers,
      },
      body: JSON.stringify(
        input && typeof input === 'object' && !Array.isArray(input)
          ? { address: customerAddress(), ...input }
          : input,
      ),
    },
    host,
  );
}
function patch(id, input, headers = {}) {
  return request('/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
}
async function register(input = { name: '고객', phoneNumber: phone() }) {
  const response = await create(input);
  assert.equal(response.status, 201);
  return (await response.json()).data.customerSeq;
}
const adminHeaders = () => ({ Cookie: adminCookie, Origin: origin });
async function callFor(id) {
  const number = (
    await pool.query('SELECT phone_number FROM customers WHERE customer_seq=$1', [id])
  ).rows[0].phone_number;
  const response = await request('/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phoneNumber: number,
      call: { providerCallId: randomUUID(), incomingAt: new Date().toISOString() },
    }),
  });
  assert.equal(response.status, 200);
  return { call_session_seq: String((await response.json()).data.callSessionSeq) };
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

test('customer service authentication rejects invalid callers before reading or changing business data', async () => {
  const id = await register();
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM customers) AS customers,
        (SELECT count(*) FROM call_sessions) AS calls`)
    ).rows[0];
  const previous = await counts();
  const name = (await pool.query('SELECT name FROM customers WHERE customer_seq=$1', [id])).rows[0]
    .name;
  for (const [method, path, body] of [
    ['GET', '/' + id, undefined],
    ['POST', '', { name: '거절할 고객', phoneNumber: phone() }],
    [
      'POST',
      '/context',
      {
        phoneNumber: phone(),
        call: { providerCallId: randomUUID(), incomingAt: new Date().toISOString() },
      },
    ],
    ['PATCH', '/' + id, { name: '거절할 이름' }],
  ]) {
    for (const authorization of [undefined, 'Bearer wrong-business-token']) {
      const response = await fetch(base + '/api/customers' + path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(authorization === undefined ? {} : { Authorization: authorization }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      await error(response, 401, 'UNAUTHORIZED');
      const events = (
        await pool.query('SELECT actor_type,result FROM audit_logs WHERE request_id=$1', [
          response.headers.get('x-request-id'),
        ])
      ).rows;
      assert.ok(events.every((event) => event.actor_type !== 'AI' && event.result !== 'SUCCESS'));
    }
  }
  assert.deepEqual(await counts(), previous);
  assert.equal(
    (await pool.query('SELECT name FROM customers WHERE customer_seq=$1', [id])).rows[0].name,
    name,
  );
});

test('unconfigured customer service auth fails closed while administrator access and Swagger remain valid', async () => {
  const { ConfigService } = require('@nestjs/config');
  const config = app.get(ConfigService);
  const token = config.get('AI_BUSINESS_TOKEN');
  try {
    config.set('AI_BUSINESS_TOKEN', '');
    await error(
      await fetch(base + '/api/customers/1', { headers: { Authorization: 'Bearer ' + token } }),
      503,
      'DEPENDENCY_UNAVAILABLE',
    );
    assert.equal((await fetch(base + '/api/customers', { headers: adminHeaders() })).status, 200);
  } finally {
    config.set('AI_BUSINESS_TOKEN', token);
  }
});

test('authenticated AI can register, read and rename without a cookie, call header or Origin', async () => {
  const input = { name: '  새 고객  ', phoneNumber: phone() };
  const response = await create(input);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.deepEqual(Object.keys(body.data), ['customerSeq']);
  const id = body.data.customerSeq;
  const detail = await request('/' + id);
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).data, {
    customerSeq: id,
    name: '새 고객',
    phoneNumber: input.phoneNumber,
    status: 'ACTIVE',
    monthlyBillingEnabled: false,
    address: customerAddress(),
  });
  const updated = await patch(id, { name: '  변경 고객  ' });
  assert.equal(updated.status, 204);
  assert.equal(await updated.text(), '');
  assert.equal((await (await request('/' + id)).json()).data.name, '변경 고객');
});

test('registration requires an address for AI and administrators without creating partial customers', async () => {
  const before = (await pool.query('SELECT count(*) FROM customers')).rows[0].count;
  const incomplete = ['roadAddress', 'jibunAddress', 'dongName', 'postalCode'].map((field) => ({
    ...customerAddress(),
    [field]: undefined,
  }));
  for (const headers of [{}, adminHeaders()]) {
    for (const address of [undefined, null, {}, [], '주소', ...incomplete]) {
      const response = await create(
        { name: '미등록 주소 고객', phoneNumber: phone(), address },
        undefined,
        base,
        headers,
      );
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error.code, 'INVALID_REQUEST');
      assert.ok(body.error.details.some((detail) => detail.field.startsWith('address')));
    }
  }
  assert.equal((await pool.query('SELECT count(*) FROM customers')).rows[0].count, before);
  for (const headers of [{}, adminHeaders()]) {
    for (const detailAddress of [undefined, '']) {
      const address = {
        ...customerAddress(),
        ...(detailAddress === undefined ? {} : { detailAddress }),
      };
      const response = await create(
        { name: '주소 등록 고객', phoneNumber: phone(), address },
        undefined,
        base,
        headers,
      );
      assert.equal(response.status, 201);
      const id = (await response.json()).data.customerSeq;
      assert.deepEqual((await (await request('/' + id)).json()).data.address, address);
    }
  }
});

test('customer list and status changes require a real active administrator; forged headers grant nothing', async () => {
  const id = await register();
  for (const cookie of [undefined, 'dva_session=bad', 'dva_session=' + 'f'.repeat(64)]) {
    const headers = {
      Origin: origin,
      Authorization: undefined,
      'X-Admin-User-Seq': String(adminId),
      'X-AI-Client': 'true',
    };
    if (cookie) headers.Cookie = cookie;
    await error(await request('', { headers }), 401, 'UNAUTHORIZED');
    await error(
      await patch(id, { name: '실패', status: 'WITHDRAWN' }, headers),
      401,
      'UNAUTHORIZED',
    );
  }
  assert.equal((await (await request('/' + id)).json()).data.status, 'ACTIVE');
  assert.notEqual((await (await request('/' + id)).json()).data.name, '실패');
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const { cookie } = await account(role);
    const headers = { Cookie: cookie, Origin: origin };
    assert.equal((await request('', { headers })).status, 200);
    assert.equal((await patch(id, { status: 'ACTIVE' }, headers)).status, 204);
  }
});

test('list supports literal name search, partial phone, state and stable offset pages', async () => {
  const prefix = '목록' + randomUUID();
  const inputs = ['Alpha%_', 'alpha', 'beta'].map((name) => ({
    name: prefix + name,
    phoneNumber: phone(),
  }));
  const ids = [];
  for (const input of inputs) ids.push(await register(input));
  await patch(ids[1], { status: 'WITHDRAWN' }, adminHeaders());
  const list = async (query) => {
    const response = await request('?' + new URLSearchParams(query), { headers: adminHeaders() });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ['data', 'hasNext', 'total_count']);
    return result;
  };
  const first = await list({ q: prefix, limit: '2', offset: '0' });
  assert.deepEqual(
    first.data.map((row) => row.customerSeq),
    ids.toReversed().slice(0, 2),
  );
  assert.equal(first.hasNext, true);
  const second = await list({ q: prefix, limit: '2', offset: '2' });
  assert.deepEqual(
    second.data.map((row) => row.customerSeq),
    [ids[0]],
  );
  assert.equal(second.hasNext, false);
  assert.equal((await list({ q: prefix.toUpperCase() + 'ALPHA%_' })).data[0].customerSeq, ids[0]);
  assert.equal((await list({ phoneNumber: inputs[0].phoneNumber })).data[0].customerSeq, ids[0]);
  for (const fragment of [
    inputs[0].phoneNumber.slice(0, 3),
    inputs[0].phoneNumber.slice(3, 7),
    inputs[0].phoneNumber.slice(-4),
    inputs[0].phoneNumber.slice(1),
  ]) {
    const expected = inputs
      .map((input, index) => ({ ...input, id: ids[index] }))
      .filter((input) => input.phoneNumber.includes(fragment))
      .map((input) => input.id)
      .toReversed();
    const partial = await list({ q: prefix, phoneNumber: fragment });
    assert.deepEqual(
      partial.data.map((row) => row.customerSeq),
      expected,
    );
    assert.equal(partial.total_count, expected.length);
  }
  const filtered = await list({ q: prefix, phoneNumber: '010', status: 'WITHDRAWN', limit: '1' });
  assert.deepEqual(
    filtered.data.map((row) => row.customerSeq),
    [ids[1]],
  );
  assert.equal(filtered.total_count, 1);
  assert.deepEqual((await list({ phoneNumber: phone() })).data, []);
  assert.deepEqual(
    (await list({ q: prefix, status: 'WITHDRAWN' })).data.map((row) => row.customerSeq),
    [ids[1]],
  );
  assert.deepEqual(await list({ q: prefix, offset: '1000' }), {
    data: [],
    hasNext: false,
    total_count: 3,
  });
  for (const query of [
    'limit=0',
    'limit=101',
    'offset=-1',
    'offset=1.5',
    'q=a&q=b',
    'phoneNumber=010-1234',
    'phoneNumber=',
    'phoneNumber=123456789012',
    'phoneNumber=%25',
    'phoneNumber=123&phoneNumber=456',
    'status=INACTIVE',
    'page=1',
  ])
    await error(await request('?' + query, { headers: adminHeaders() }), 400, 'INVALID_REQUEST');
});

async function paymentCustomer({
  name = '결제수단' + randomUUID(),
  customerMonthly = true,
  membershipStatus,
  organizationStatus = 'ACTIVE',
  organizationMonthly = true,
  groupBilling = true,
} = {}) {
  const customer = (
    await pool.query(
      `INSERT INTO customers(name,phone_number,status,monthly_billing_enabled)
       VALUES($1,$2,'ACTIVE',$3) RETURNING customer_seq,phone_number`,
      [name, phone(), customerMonthly],
    )
  ).rows[0];
  if (membershipStatus !== undefined) {
    customer.organization_seq = (
      await pool.query(
        `INSERT INTO organizations(name,status,monthly_billing_enabled)
         VALUES('결제 검증 기업',$1,$2) RETURNING organization_seq`,
        [organizationStatus, organizationMonthly],
      )
    ).rows[0].organization_seq;
    customer.membership_seq = (
      await testMembership(pool, {
        customerSeq: customer.customer_seq,
        organizationSeq: customer.organization_seq,
        employeeNo: randomUUID(),
        status: membershipStatus,
        groupBillingEnabled: groupBilling,
      })
    ).rows[0].membership_seq;
  }
  return customer;
}

async function paymentMethods(customer, expected) {
  const listing = await request('?phoneNumber=' + customer.phone_number, {
    headers: adminHeaders(),
  });
  assert.equal(listing.status, 200);
  assert.equal(listing.headers.get('cache-control'), 'no-store');
  const body = await listing.json();
  assert.equal(body.total_count, 1);
  assert.equal(body.hasNext, false);
  assert.equal(body.data.length, 1);
  const row = body.data[0];
  assert.equal(row.customerSeq, customer.customer_seq);
  assert.deepEqual(row.availablePaymentMethods, expected);
  assert.deepEqual(Object.keys(row).sort(), [
    'address',
    'availablePaymentMethods',
    'customerSeq',
    'monthlyBillingEnabled',
    'name',
    'phoneNumber',
    'status',
  ]);
  const response = await request('/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: customer.phone_number }),
  });
  assert.equal(response.status, 200);
  const context = (await response.json()).data;
  assert.deepEqual(row.availablePaymentMethods, context.availablePaymentMethods);
  const { availablePaymentMethods, ...profile } = row;
  if (context.customer) assert.deepEqual(profile, context.customer);
}

test('customer list and caller context agree on personal and independent company payment eligibility', async () => {
  for (const customerMonthly of [false, true]) {
    const customer = await paymentCustomer({ customerMonthly });
    await paymentMethods(customer, customerMonthly ? ['billing', 'credit'] : ['billing']);
  }
  for (const membershipStatus of ['ACTIVE', 'INACTIVE']) {
    for (const organizationStatus of ['ACTIVE', 'INACTIVE']) {
      for (const organizationMonthly of [false, true]) {
        for (const groupBilling of [false, true]) {
          const customer = await paymentCustomer({
            membershipStatus,
            organizationStatus,
            organizationMonthly,
            groupBilling,
          });
          const active = membershipStatus === 'ACTIVE' && organizationStatus === 'ACTIVE';
          await paymentMethods(customer, [
            'billing',
            ...(active && organizationMonthly ? ['credit'] : []),
            ...(active && groupBilling ? ['groupBilling'] : []),
          ]);
        }
      }
    }
  }
});

test('customer list payment methods reflect withdrawal and deleted or missing company links on the next read', async () => {
  for (const change of [
    'UPDATE memberships SET deleted_at=clock_timestamp() WHERE customer_seq=$1',
    'UPDATE organizations SET deleted_at=clock_timestamp() WHERE organization_seq=(SELECT organization_seq FROM memberships WHERE customer_seq=$1)',
    'UPDATE departments SET deleted_at=clock_timestamp() WHERE department_seq=(SELECT department_seq FROM memberships WHERE customer_seq=$1)',
    'UPDATE memberships SET department_seq=NULL WHERE customer_seq=$1',
    "UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1",
    'UPDATE customers SET deleted_at=clock_timestamp() WHERE customer_seq=$1',
  ]) {
    const customer = await paymentCustomer({ membershipStatus: 'ACTIVE' });
    await paymentMethods(customer, ['billing', 'credit', 'groupBilling']);
    await pool.query(change, [customer.customer_seq]);
    if (change.startsWith('UPDATE customers SET deleted_at')) {
      const response = await request('?phoneNumber=' + customer.phone_number, {
        headers: adminHeaders(),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { data: [], hasNext: false, total_count: 0 });
    } else {
      const expected = change.includes("status='WITHDRAWN'")
        ? []
        : change.startsWith('UPDATE organizations')
          ? ['billing']
          : ['billing', 'credit'];
      await paymentMethods(customer, expected);
    }
  }
});

test('deleted membership history does not duplicate customer payment rows or pagination totals', async () => {
  const prefix = '결제페이지' + randomUUID();
  const customers = [];
  for (let index = 0; index < 3; index++) {
    const customer = await paymentCustomer({ name: prefix + index, membershipStatus: 'ACTIVE' });
    for (let history = 0; history < 2; history++) {
      await pool.query(
        'UPDATE memberships SET deleted_at=clock_timestamp() WHERE customer_seq=$1',
        [customer.customer_seq],
      );
      await testMembership(pool, {
        customerSeq: customer.customer_seq,
        organizationSeq: customer.organization_seq,
        employeeNo: randomUUID(),
        groupBillingEnabled: true,
      });
    }
    customers.push(customer);
  }
  for (const [offset, ids, hasNext] of [
    [0, customers.toReversed().slice(0, 2), true],
    [2, [customers[0]], false],
    [20, [], false],
  ]) {
    const response = await request(`?q=${prefix}&limit=2&offset=${offset}`, {
      headers: adminHeaders(),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total_count, 3);
    assert.equal(result.hasNext, hasNext);
    assert.deepEqual(
      result.data.map((row) => row.customerSeq),
      ids.map((customer) => customer.customer_seq),
    );
    for (const row of result.data)
      assert.deepEqual(row.availablePaymentMethods, ['billing', 'credit', 'groupBilling']);
  }
});

test('validation rejects invalid bodies, nulls, phone changes, unknown fields and invalid IDs without writes', async () => {
  const id = await register();
  const before = (await pool.query('SELECT count(*) FROM customers')).rows[0].count;
  for (const input of [
    {},
    { name: ' ', phoneNumber: phone() },
    { name: null, phoneNumber: phone() },
    { name: '고객', phoneNumber: 1012345678 },
    { name: '고객', phoneNumber: '' },
    { name: '고객', phoneNumber: '010-1234' },
    { name: '고객', phoneNumber: '+821012345678' },
    { name: '고객', phoneNumber: ' 01012345678' },
    { name: '고객', phoneNumber: phone(), status: 'ACTIVE' },
    { name: '고객', phoneNumber: phone(), customerSeq: 1 },
  ])
    await error(await create(input), 400, 'INVALID_REQUEST');
  for (const input of [
    {},
    { name: null },
    { name: ' ' },
    { phoneNumber: phone() },
    { name: '실패', phoneNumber: phone() },
    { unknown: true },
  ])
    await error(await patch(id, input), 400, 'INVALID_REQUEST');
  for (const status of [null, 'INACTIVE', 1])
    await error(await patch(id, { status }, adminHeaders()), 400, 'INVALID_REQUEST');
  for (const value of ['0', '-1', '1.5', '2147483648', 'invalid']) {
    await error(await request('/' + value), 400, 'INVALID_REQUEST');
    await error(await patch(value, { name: '실패' }), 400, 'INVALID_REQUEST');
  }
  await error(await request('/2147483647'), 404, 'NOT_FOUND');
  await error(await patch(2147483647, { name: '실패' }), 404, 'NOT_FOUND');
  assert.equal((await pool.query('SELECT count(*) FROM customers')).rows[0].count, before);
});

test('registration uses phone uniqueness without a request key and preserves the existing customer', async () => {
  const input = { name: '기존 고객', phoneNumber: phone() };
  const id = await register(input);
  await error(await create(input), 409, 'DUPLICATE_RESOURCE');
  await error(
    await create({ ...input, name: '덮어쓰면 안 됨' }, 'legacy-key', baseB),
    409,
    'DUPLICATE_RESOURCE',
  );
  const restarted = await start();
  await error(await create(input, undefined, await restarted.getUrl()), 409, 'DUPLICATE_RESOURCE');
  const current = (await (await request('/' + id)).json()).data;
  assert.equal(current.name, input.name);
  assert.equal(current.status, 'ACTIVE');
  assert.equal((await create({ name: '새 고객', phoneNumber: phone() }, 'legacy-key')).status, 201);
});

test('concurrent phone collisions across application instances create exactly one customer', async () => {
  const input = { name: '동시 고객', phoneNumber: phone() };
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => create(input, undefined, i % 2 ? base : baseB)),
  );
  assert.equal(results.filter((response) => response.status === 201).length, 1);
  for (const response of results.filter((response) => response.status !== 201))
    await error(response, 409, 'DUPLICATE_RESOURCE');
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [input.phoneNumber]))
      .rows[0].count,
    '1',
  );
});

test('customer transaction failure rolls back registration and leaves the phone available', async () => {
  const input = { name: '롤백 고객', phoneNumber: phone() };
  const original = repository.insert;
  repository.insert = async (...args) => {
    await original.apply(repository, args);
    throw new Error('private customer failure');
  };
  try {
    const response = await create(input);
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('private customer failure'));
    assert.equal(
      (
        await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [
          input.phoneNumber,
        ])
      ).rows[0].count,
      '0',
    );
  } finally {
    repository.insert = original;
  }
  assert.equal((await create(input)).status, 201);
});

test('withdrawal preserves related data, prevents AI access, duplicate registration and reactivation', async () => {
  const input = { name: '탈퇴 고객', phoneNumber: phone() };
  const key = randomUUID();
  const created = await create(input, key);
  const id = (await created.json()).data.customerSeq;
  const company = await pool.query(
    "INSERT INTO organizations(name,status) VALUES('탈퇴 관계 기업','ACTIVE') RETURNING organization_seq",
  );
  const companyId = company.rows[0].organization_seq;
  await testMembership(pool, { customerSeq: id, organizationSeq: companyId, employeeNo: '001' });
  await pool.query('INSERT INTO orders(customer_seq) VALUES($1)', [id]);
  const address = {
    name: '수령인',
    phoneNumber: '01000000000',
    roadAddress: '테스트로 1',
    jibunAddress: '테스트동 1',
    detailAddress: '',
    dongName: '테스트동',
    postalCode: '12345',
  };
  await pool.query('INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2::jsonb)', [
    id,
    JSON.stringify(address),
  ]);
  assert.equal((await patch(id, { status: 'WITHDRAWN' }, adminHeaders())).status, 204);
  await error(await request('/' + id), 404, 'NOT_FOUND');
  await error(await patch(id, { name: '재활성화 시도' }), 404, 'NOT_FOUND');
  await error(await create(input), 409, 'DUPLICATE_RESOURCE');
  const replay = await create(input, key);
  await error(replay, 409, 'DUPLICATE_RESOURCE');
  await error(
    await patch(id, { name: '실패', status: 'ACTIVE' }, adminHeaders()),
    409,
    'INVALID_STATE',
  );
  const detail = await request('/' + id, { headers: adminHeaders() });
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).data, {
    customerSeq: id,
    ...input,
    status: 'WITHDRAWN',
    monthlyBillingEnabled: false,
    address: customerAddress(),
  });
  assert.equal(
    (await pool.query('SELECT status FROM memberships WHERE customer_seq=$1', [id])).rows[0].status,
    'ACTIVE',
  );
  for (const table of ['orders', 'personal_pins'])
    assert.equal(
      (await pool.query(`SELECT count(*) FROM ${table} WHERE customer_seq=$1`, [id])).rows[0].count,
      '1',
    );
});

test('customer create/name/status writes record AI or the administrator name without retaining request payloads', async () => {
  const created = await create();
  assert.equal(created.status, 201);
  const id = (await created.json()).data.customerSeq;
  const renamed = await patch(id, { name: 'AI 수정 이름' });
  assert.equal(renamed.status, 204);
  const withdrawn = await patch(id, { status: 'WITHDRAWN' }, adminHeaders());
  assert.equal(withdrawn.status, 204);
  const adminCreated = await create(undefined, undefined, base, adminHeaders());
  assert.equal(adminCreated.status, 201);
  for (const [response, action, actorType] of [
    [created, 'CUSTOMER_CREATED', 'AI'],
    [renamed, 'CUSTOMER_UPDATED', 'AI'],
    [withdrawn, 'CUSTOMER_UPDATED', 'ADMIN'],
    [adminCreated, 'CUSTOMER_CREATED', 'ADMIN'],
  ]) {
    const rows = (
      await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
        response.headers.get('x-request-id'),
      ])
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, action);
    assert.equal(rows[0].actor_type, actorType);
    assert.equal(rows[0].actor_seq, actorType === 'AI' ? null : adminId);
    assert.equal(rows[0].actor_name, actorType === 'AI' ? 'AI' : '고객 테스트');
    assert.deepEqual(rows[0].metadata, {});
    assert.equal(rows[0].result, 'SUCCESS');
  }
});

test('customer audit failure rolls back creation or changes; rejected sessions never fall back to AI', async () => {
  const { AuditService } = require('../dist/audit/audit.service');
  const audit = app.get(AuditService);
  const original = audit.recordSuccess;
  const existing = await register({ name: '원래 이름', phoneNumber: phone() });
  const input = { name: '저장 실패', phoneNumber: phone() };
  audit.recordSuccess = async () => {
    throw new Error('simulated audit failure');
  };
  try {
    for (const response of [await create(input), await patch(existing, { name: '롤백될 이름' })]) {
      await error(response, 500, 'INTERNAL_ERROR');
      const rows = (
        await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
          response.headers.get('x-request-id'),
        ])
      ).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].actor_type, 'AI');
      assert.equal(rows[0].result, 'FAILED');
    }
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(
    (await pool.query('SELECT 1 FROM customers WHERE phone_number=$1', [input.phoneNumber]))
      .rowCount,
    0,
  );
  assert.equal(
    (await pool.query('SELECT name FROM customers WHERE customer_seq=$1', [existing])).rows[0].name,
    '원래 이름',
  );
  const denied = await patch(
    existing,
    { name: '실패' },
    { Origin: origin, Cookie: 'dva_session=invalid' },
  );
  await error(denied, 401, 'UNAUTHORIZED');
  const rows = (
    await pool.query('SELECT actor_type,result FROM audit_logs WHERE request_id=$1', [
      denied.headers.get('x-request-id'),
    ])
  ).rows;
  assert.deepEqual(rows, [{ actor_type: 'SYSTEM', result: 'DENIED' }]);
});

test('own address is nullable, validated, available in reads and independent of PINs', async () => {
  const address = {
    roadAddress: '내주소로 1',
    jibunAddress: '내주소동 1',
    detailAddress: '101호',
    dongName: '내주소동',
    postalCode: '01234',
  };
  const number = phone();
  const id = await register({ name: '주소 고객', phoneNumber: number, address });
  const detail = async () => (await (await request('/' + id)).json()).data;
  assert.deepEqual((await detail()).address, address);
  const pin = { ...address, roadAddress: '다른배송로 2', name: '배송 수령인', phoneNumber: number };
  await pool.query('INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2)', [id, pin]);
  const contextResponse = await fetch(base + '/api/customers/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...businessHeaders() },
    body: JSON.stringify({ phoneNumber: number }),
  });
  const context = (await contextResponse.json()).data;
  assert.deepEqual(context.customer.address, address);
  assert.equal(context.personalPins[0].addressData.roadAddress, '다른배송로 2');
  const listing = (
    await (await request('?phoneNumber=' + number, { headers: adminHeaders() })).json()
  ).data;
  assert.deepEqual(listing[0].address, address);
  assert.equal((await patch(id, { name: '이름만 변경' })).status, 204);
  assert.deepEqual((await detail()).address, address);
  const replacement = { ...address, roadAddress: '새내주소로 3' };
  const ai = await callFor(id);
  assert.equal((await patch(id, { address: replacement }, ai)).status, 204);
  assert.deepEqual((await detail()).address, replacement);
  assert.deepEqual(
    (await pool.query('SELECT address_data FROM personal_pins WHERE customer_seq=$1', [id])).rows[0]
      .address_data,
    pin,
  );
  for (const invalid of [
    {},
    [],
    'text',
    { ...address, latitude: 91 },
    { ...address, longitude: -181 },
    { ...address, postalCode: '1234' },
    { ...address, detailAddress: null },
    { ...address, name: '중복 이름' },
    { ...address, longitude: '127' },
  ]) {
    await error(await patch(id, { address: invalid }, ai), 400, 'INVALID_REQUEST');
    assert.deepEqual((await detail()).address, replacement);
    await assert.rejects(
      () =>
        pool.query('UPDATE customers SET address_data=$2::jsonb WHERE customer_seq=$1', [
          id,
          JSON.stringify(invalid),
        ]),
      (e) => e.code === '23514',
    );
  }
  assert.equal((await patch(id, { address: null }, ai)).status, 204);
  assert.equal((await detail()).address, null);
  assert.equal(
    (await pool.query('SELECT count(*) FROM personal_pins WHERE customer_seq=$1', [id])).rows[0]
      .count,
    '1',
  );
});

test('address-only updates roll back when success audit fails', async () => {
  const id = await register();
  const ai = await callFor(id);
  const { AuditService } = require('../dist/audit/audit.service');
  const audit = app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async () => {
    throw new Error('test address audit failure');
  };
  try {
    await error(
      await patch(
        id,
        {
          address: {
            roadAddress: '원자성로 1',
            jibunAddress: '원자성동 1',
            dongName: '원자성동',
            postalCode: '01234',
          },
        },
        ai,
      ),
      500,
      'INTERNAL_ERROR',
    );
  } finally {
    audit.recordSuccess = original;
  }
  assert.deepEqual((await (await request('/' + id)).json()).data.address, customerAddress());
});

test('AI basic address changes require a matching ongoing call while administrator and name-only updates keep their contracts', async () => {
  const id = await register({ name: '주소 권한 고객', phoneNumber: phone() });
  const replacement = {
    roadAddress: '통화로 1',
    jibunAddress: '통화동 1',
    dongName: '통화동',
    postalCode: '01234',
  };
  for (const header of [undefined, '0', '-1', '1.5', 'abc', '2147483648', '1,2'])
    await error(
      await patch(
        id,
        { name: '저장되면 안 됨', address: replacement },
        header === undefined ? {} : { call_session_seq: header },
      ),
      400,
      'INVALID_REQUEST',
    );
  await error(
    await patch(id, { address: replacement }, { call_session_seq: '2147483647' }),
    404,
    'NOT_FOUND',
  );
  const other = await register();
  await error(await patch(id, { address: replacement }, await callFor(other)), 403, 'FORBIDDEN');
  const ai = await callFor(id);
  assert.equal((await patch(id, { address: replacement }, ai)).status, 204);
  await pool.query(
    "UPDATE call_sessions SET started_at=clock_timestamp()-interval '1 minute',ended_at=clock_timestamp() WHERE call_session_seq=$1",
    [ai.call_session_seq],
  );
  await error(await patch(id, { name: '종료 후 변경', address: null }, ai), 409, 'INVALID_STATE');
  const customer = (await (await request('/' + id)).json()).data;
  assert.equal(customer.name, '주소 권한 고객');
  assert.deepEqual(customer.address, replacement);
  assert.equal((await patch(id, { name: '기존 이름 수정' })).status, 204);
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const actor = await account(role);
    assert.equal(
      (await patch(id, { address: null }, { Cookie: actor.cookie, Origin: origin })).status,
      204,
    );
  }
});

test('AI basic address writes reject deleted and expired calls and cannot cross a stored customer identity', async () => {
  const id = await register();
  const other = await register();
  for (const change of [
    'customer_seq=$2',
    'deleted_at=clock_timestamp()',
    "incoming_at=clock_timestamp()-interval '6 years'",
  ]) {
    const ai = await callFor(id);
    await pool.query(
      `UPDATE call_sessions SET ${change} WHERE call_session_seq=$1`,
      change.includes('$2') ? [ai.call_session_seq, other] : [ai.call_session_seq],
    );
    await error(
      await patch(id, { address: null }, ai),
      change.includes('$2') ? 403 : 404,
      change.includes('$2') ? 'FORBIDDEN' : 'NOT_FOUND',
    );
  }
});

test('a customer address write waiting behind call termination rechecks the end time before saving', async () => {
  const id = await register({ name: '종료 경합 고객', phoneNumber: phone() });
  const ai = await callFor(id);
  const transaction = await pool.connect();
  let pending;
  try {
    await transaction.query('BEGIN');
    const pid = (await transaction.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await transaction.query('SELECT 1 FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE', [
      ai.call_session_seq,
    ]);
    pending = request('/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...ai },
      body: JSON.stringify({ name: '저장되면 안 됨', address: null }),
      signal: AbortSignal.timeout(8000),
    });
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (
        await pool.query(
          'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
          [pid],
        )
      ).rows[0].waiting;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'the address write must lock its call before the customer');
    await transaction.query(
      "UPDATE call_sessions SET started_at=clock_timestamp()-interval '1 minute',ended_at=clock_timestamp() WHERE call_session_seq=$1",
      [ai.call_session_seq],
    );
    await transaction.query('COMMIT');
    await error(await pending, 409, 'INVALID_STATE');
    assert.equal((await (await request('/' + id)).json()).data.name, '종료 경합 고객');
  } finally {
    await transaction.query('ROLLBACK');
    transaction.release();
    await pending?.catch(() => {});
  }
});

test('admin arrays soft-delete customers, memberships and PINs while preserving orders and calls', async () => {
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const actor = await account(role);
    const ids = [await register(), await register()];
    const organization = (
      await pool.query(
        "INSERT INTO organizations(name,status) VALUES('삭제 회귀 기업','ACTIVE') RETURNING organization_seq",
      )
    ).rows[0].organization_seq;
    await testMembership(pool, {
      customerSeq: ids[0],
      organizationSeq: organization,
      employeeNo: randomUUID(),
      role: 'MEMBER',
      status: 'ACTIVE',
    });
    const pin = (
      await pool.query(
        'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2) RETURNING personal_pin_seq',
        [ids[0], { ...customerAddress(), name: '보존 수령인', phoneNumber: phone() }],
      )
    ).rows[0].personal_pin_seq;
    const order = (
      await pool.query(
        "INSERT INTO orders(customer_seq,status) VALUES($1,'COLLECTING') RETURNING order_seq",
        [ids[0]],
      )
    ).rows[0].order_seq;
    const callId = (
      await pool.query(
        'INSERT INTO call_sessions(provider_call_id,customer_seq,order_seq) VALUES($1,$2,$3) RETURNING call_session_seq',
        [randomUUID(), ids[0], order],
      )
    ).rows[0].call_session_seq;
    const history = async () =>
      (
        await pool.query(
          "SELECT jsonb_build_object('order',(SELECT to_jsonb(o) FROM orders o WHERE order_seq=$1),'call',(SELECT to_jsonb(c) FROM call_sessions c WHERE call_session_seq=$2)) AS data",
          [order, callId],
        )
      ).rows[0].data;
    const before = await history();
    const requestId = randomUUID();
    const response = await request('', {
      method: 'DELETE',
      headers: {
        Origin: origin,
        Cookie: actor.cookie,
        'Content-Type': 'application/json',
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({ customerSeqs: ids.toReversed() }),
    });
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await history(), before);
    const deleted = await pool.query(
      'SELECT deleted_at FROM customers WHERE customer_seq=ANY($1::int[])',
      [ids],
    );
    assert.equal(deleted.rowCount, 2);
    assert.ok(deleted.rows.every((row) => row.deleted_at));
    assert.ok(
      (await pool.query('SELECT deleted_at FROM personal_pins WHERE personal_pin_seq=$1', [pin]))
        .rows[0].deleted_at,
    );
    assert.ok(
      (await pool.query('SELECT deleted_at FROM memberships WHERE customer_seq=$1', [ids[0]]))
        .rows[0].deleted_at,
    );
    for (const id of ids)
      await error(await request('/' + id, { headers: { Cookie: actor.cookie } }), 404, 'NOT_FOUND');
    const audits = (
      await pool.query(
        "SELECT actor_seq,target_seq FROM audit_logs WHERE request_id=$1 AND action='CUSTOMER_DELETED' AND result='SUCCESS' ORDER BY target_seq",
        [requestId],
      )
    ).rows;
    assert.deepEqual(
      audits,
      ids.map((id) => ({ actor_seq: actor.id, target_seq: id })),
    );
    const single = await register();
    assert.equal(
      (
        await request('', {
          method: 'DELETE',
          headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ customerSeqs: [single] }),
        })
      ).status,
      204,
    );
  }
});

test('customer deletion validates arrays and admin access and rolls back missing rows or audit failure', async () => {
  const ids = [await register(), await register()];
  const remove = (values, headers = adminHeaders()) =>
    request('', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ customerSeqs: values }),
    });
  for (const values of [
    [],
    [ids[0], ids[0]],
    ['1'],
    [0],
    [-1],
    [1.1],
    [2147483648],
    Array.from({ length: 101 }, (_, i) => i + 1),
    null,
  ])
    await error(await remove(values), 400, 'INVALID_REQUEST');
  await error(await remove(ids, { ...businessHeaders(), Origin: origin }), 401, 'UNAUTHORIZED');
  await error(
    await remove(ids, { ...adminHeaders(), Origin: 'https://untrusted.example' }),
    403,
    'FORBIDDEN',
  );
  await error(await remove([ids[0], 2147483647]), 404, 'NOT_FOUND');
  const audit = app.get(require('../dist/audit/audit.service').AuditService);
  const original = audit.recordSuccess;
  const requestId = randomUUID();
  let writes = 0;
  audit.recordSuccess = async function (event, client) {
    if (event.action === 'CUSTOMER_DELETED' && ++writes === 2)
      throw new Error('test-only customer audit failure');
    return original.call(this, event, client);
  };
  try {
    await error(
      await remove(ids, { ...adminHeaders(), 'X-Request-Id': requestId }),
      500,
      'INTERNAL_ERROR',
    );
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM customers WHERE customer_seq=ANY($1::int[]) AND deleted_at IS NULL',
        [ids],
      )
    ).rowCount,
    2,
  );
  assert.equal(
    (
      await pool.query("SELECT 1 FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
        requestId,
      ])
    ).rowCount,
    0,
  );
  assert.equal((await remove([ids[1]])).status, 204);
  await error(await remove(ids), 404, 'NOT_FOUND');
  assert.equal(
    (await pool.query('SELECT deleted_at FROM customers WHERE customer_seq=$1', [ids[0]])).rows[0]
      .deleted_at,
    null,
  );
});

test('customer deletion serializes reverse overlapping arrays and recovers after a bounded lock conflict', async () => {
  const ids = [await register(), await register()];
  const remove = (values) =>
    request('', {
      method: 'DELETE',
      headers: { ...adminHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerSeqs: values }),
    });
  assert.deepEqual(
    (await Promise.all([remove(ids), remove(ids.toReversed())])).map((r) => r.status).sort(),
    [204, 404],
  );
  const held = await register();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM customers WHERE customer_seq=$1 FOR UPDATE', [held]);
    await error(await remove([held]), 409, 'REQUEST_IN_PROGRESS');
    assert.equal(
      (await client.query('SELECT deleted_at FROM customers WHERE customer_seq=$1', [held])).rows[0]
        .deleted_at,
      null,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await remove([held])).status, 204);
});
