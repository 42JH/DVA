require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { migrate } = require('./helpers/migrations.cjs');
const { createTestSession, createTestPool, startTestApp } = require('./helpers/application.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'false';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { MembersRepository } = require('../dist/members/members.repository');

const pool = createTestPool();
const apps = [];
const origin = 'http://localhost:5173';
const departments = new Map();
const employees = (companyId, fixture) =>
  fixture.split('\n').map((row) => {
    const [employeeNo, name, phoneNumber] = row.split(',');
    return { employeeNo, name, phoneNumber, departmentSeq: departments.get(companyId) };
  });
const phone = () => '010' + String(randomInt(10000000, 100000000));
let app, base, baseB, cookie, repository;
const start = () => startTestApp(apps);
async function account(role = 'OPERATOR') {
  const loginId = 'mem' + randomUUID().replaceAll('-', '').slice(0, 16);
  const { rows } = await pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'구성원 테스트',$2,$3,'ACTIVE') RETURNING admin_user_seq",
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
  cookie = admin.cookie;
  repository = app.get(MembersRepository);
});
after(async () => {
  for (const instance of apps) await instance.close();
  await pool.end();
});

function request(path, options = {}, host = base, session = cookie) {
  const headers = { Origin: origin, ...options.headers };
  if (session !== null) headers.Cookie = session;
  return fetch(host + '/api' + path, { ...options, headers });
}
function create(
  companyId,
  customerSeq,
  employeeNo = '001',
  key = undefined,
  role = 'MEMBER',
  host = base,
  session = cookie,
) {
  return request(
    `/companies/${companyId}/members`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      body: JSON.stringify({
        customerSeq,
        employeeNo,
        role,
        departmentSeq: departments.get(companyId) ?? departments.values().next().value,
      }),
    },
    host,
    session,
  );
}
function registerMany(companyId, items, key = undefined, host = base, session = cookie) {
  return request(
    `/companies/${companyId}/members`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key === undefined ? {} : { 'Idempotency-Key': key }),
      },
      body: JSON.stringify({ items }),
    },
    host,
    session,
  );
}
function patch(id, input, session = cookie) {
  return request(
    '/members/' + id,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    base,
    session,
  );
}
function remove(id, session = cookie) {
  return request(
    '/members',
    {
      method: 'DELETE',
      body: JSON.stringify({ membershipSeqs: [id] }),
      headers: { 'Content-Type': 'application/json' },
    },
    base,
    session,
  );
}
async function company(status = 'ACTIVE') {
  const id = (
    await pool.query(
      'INSERT INTO organizations(name,status) VALUES($1,$2) RETURNING organization_seq',
      ['구성원 기업 ' + randomUUID(), status],
    )
  ).rows[0].organization_seq;
  const department = await pool.query(
    "INSERT INTO departments(organization_seq,name) VALUES($1,'검증 부서') RETURNING department_seq",
    [id],
  );
  departments.set(id, department.rows[0].department_seq);
  return id;
}
async function customer(status = 'ACTIVE', number = phone(), name = '기존 고객') {
  const result = await pool.query(
    'INSERT INTO customers(name,phone_number,status) VALUES($1,$2,$3) RETURNING customer_seq',
    [name, number, status],
  );
  return { id: result.rows[0].customer_seq, phoneNumber: number, name };
}
async function members(id, query = '') {
  const response = await request(`/companies/${id}/members` + query);
  assert.equal(response.status, 200);
  return response.json();
}
async function member(companyId, customerId) {
  return (await members(companyId)).data.find((row) => row.customer.customerSeq === customerId)
    .membership;
}
async function empty(response) {
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return body;
}

test('every active admin role can manage members and representative labels create no admin account', async () => {
  const before = (await pool.query('SELECT count(*) FROM admin_users')).rows[0].count;
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const admin = await account(role);
    const co = await company();
    const cu = await customer();
    await empty(await create(co, cu.id, '001', randomUUID(), 'ORG_ADMIN', base, admin.cookie));
    const list = await request(`/companies/${co}/members`, {}, base, admin.cookie);
    assert.equal(list.status, 200);
    const row = (await list.json()).data[0];
    assert.equal(row.membership.role, 'ORG_ADMIN');
    assert.equal(row.customer.customerSeq, cu.id);
    await empty(
      await patch(
        row.membership.membershipSeq,
        { role: 'MEMBER', status: 'INACTIVE' },
        admin.cookie,
      ),
    );
    await empty(
      await registerMany(
        co,
        employees(co, `002,새 고객,${phone()}`),
        randomUUID(),
        base,
        admin.cookie,
      ),
    );
    await empty(await remove(row.membership.membershipSeq, admin.cookie));
  }
  assert.equal(
    Number((await pool.query('SELECT count(*) FROM admin_users')).rows[0].count),
    Number(before) + 3,
  );
});

test('lists return nested member/customer views, status filters, stable pages and empty companies', async () => {
  const co = await company();
  assert.deepEqual(await members(co), { data: [], hasNext: false, total_count: 0 });
  const ids = [];
  for (const employee of ['001', '002', '003']) {
    const cu = await customer();
    await empty(await create(co, cu.id, employee));
    ids.push((await member(co, cu.id)).membershipSeq);
  }
  await empty(await patch(ids[1], { status: 'INACTIVE' }));
  const first = await members(co, '?limit=2&offset=0');
  assert.deepEqual(Object.keys(first).sort(), ['data', 'hasNext', 'total_count']);
  assert.deepEqual(
    first.data.map((row) => row.membership.membershipSeq),
    ids.toReversed().slice(0, 2),
  );
  assert.equal(first.hasNext, true);
  const second = await members(co, '?limit=2&offset=2');
  assert.equal(second.hasNext, false);
  assert.equal(second.data[0].membership.membershipSeq, ids[0]);
  assert.equal((await members(co, '?status=INACTIVE')).data[0].membership.membershipSeq, ids[1]);
  assert.deepEqual(await members(co, '?offset=1000'), { data: [], hasNext: false, total_count: 3 });
  for (const query of [
    'status=PENDING',
    'limit=0',
    'limit=101',
    'offset=-1',
    'offset=1.1',
    'page=1',
    'status=ACTIVE&status=INACTIVE',
  ])
    await error(await request(`/companies/${co}/members?${query}`), 400, 'INVALID_REQUEST');
  await error(await request('/companies/2147483647/members'), 404, 'NOT_FOUND');
});

test('company member q searches names, employee numbers and formatted phone parts within one company', async () => {
  const co = await company();
  const other = await company();
  const cu = await customer('ACTIVE', phone(), '홍길동 Alpha');
  await empty(await create(co, cu.id, '00Ab-007'));
  const outsider = await customer('ACTIVE', phone(), cu.name);
  await empty(await create(other, outsider.id, '00Ab-007'));
  const baseline = await members(co);
  for (const q of [
    '길동',
    '  ALPHA  ',
    '홍길동',
    '00ab-007',
    cu.phoneNumber,
    `${cu.phoneNumber.slice(0, 3)}-${cu.phoneNumber.slice(3, 7)}-${cu.phoneNumber.slice(7)}`,
    cu.phoneNumber.slice(-4),
  ])
    assert.deepEqual(await members(co, '?' + new URLSearchParams({ q })), baseline, q);
  assert.deepEqual(await members(co, '?q=not-a-member'), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
  assert.equal(Object.hasOwn(baseline.data[0].customer, 'availablePaymentMethods'), false);
});

test('member q combines with status, counts filtered rows and keeps blank queries and stable pages', async () => {
  const co = await company();
  const ids = [];
  for (const name of ['검색대상', '검색대상', '다른사람', '검색대상']) {
    const cu = await customer('ACTIVE', phone(), name);
    await empty(await create(co, cu.id, String(ids.length).padStart(3, '0')));
    ids.push((await member(co, cu.id)).membershipSeq);
  }
  await empty(await patch(ids[1], { status: 'INACTIVE' }));
  const first = await members(co, '?q=검색대상&limit=2');
  assert.equal(first.total_count, 3);
  assert.equal(first.hasNext, true);
  assert.deepEqual(
    first.data.map((row) => row.membership.membershipSeq),
    [ids[3], ids[1]],
  );
  const second = await members(co, '?q=검색대상&limit=2&offset=2');
  assert.equal(second.total_count, 3);
  assert.equal(second.hasNext, false);
  assert.deepEqual(
    second.data.map((row) => row.membership.membershipSeq),
    [ids[0]],
  );
  assert.deepEqual(await members(co, '?q=없는이름&status=ACTIVE'), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
  assert.deepEqual(
    (await members(co, '?q=검색대상&status=INACTIVE')).data.map(
      (row) => row.membership.membershipSeq,
    ),
    [ids[1]],
  );
  assert.equal((await members(co, '?q=검색대상&status=ACTIVE')).total_count, 2);
  assert.deepEqual(await members(co, '?q=검색대상&offset=100'), {
    data: [],
    hasNext: false,
    total_count: 3,
  });
  const baseline = await members(co);
  for (const q of ['', '   ', '\t\n'])
    assert.deepEqual(await members(co, '?' + new URLSearchParams({ q })), baseline);
});

test('member q treats wildcard characters literally, rejects invalid queries and never removes the company boundary', async () => {
  const co = await company();
  const ids = [];
  for (const employeeNo of ['00%_A', '00XA', 'dash-', 'x'.repeat(100)]) {
    const cu = await customer();
    await empty(await create(co, cu.id, employeeNo));
    ids.push((await member(co, cu.id)).membershipSeq);
  }
  for (const [q, expected] of [
    ['%', [ids[0]]],
    ['_', [ids[0]]],
    ['%_', [ids[0]]],
    ['-', [ids[2]]],
    ['x'.repeat(100), [ids[3]]],
    ["' OR 1=1 --", []],
    ['\\', []],
  ]) {
    const result = await members(co, '?' + new URLSearchParams({ q }));
    assert.deepEqual(
      result.data.map((row) => row.membership.membershipSeq),
      expected,
    );
    assert.equal(result.total_count, expected.length);
  }
  for (const query of ['q=' + 'x'.repeat(101), 'q=a&q=b', 'q%5B%5D=a', 'q%5Bname%5D=a', 'q=%00'])
    await error(await request(`/companies/${co}/members?${query}`), 400, 'INVALID_REQUEST');
});

test('member q preserves inactive and withdrawn visibility while hiding deleted links and companies', async () => {
  const co = await company();
  const customers = [];
  const ids = [];
  for (let index = 0; index < 4; index++) {
    const cu = await customer('ACTIVE', phone(), '상태검색');
    await empty(await create(co, cu.id, '00' + index));
    customers.push(cu);
    ids.push((await member(co, cu.id)).membershipSeq);
  }
  await empty(await patch(ids[1], { status: 'INACTIVE' }));
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [
    customers[1].id,
  ]);
  await pool.query('UPDATE memberships SET deleted_at=clock_timestamp() WHERE membership_seq=$1', [
    ids[2],
  ]);
  await pool.query('UPDATE customers SET deleted_at=clock_timestamp() WHERE customer_seq=$1', [
    customers[3].id,
  ]);
  await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [co]);
  const result = await members(co, '?q=상태검색');
  assert.equal(result.total_count, 2);
  assert.deepEqual(
    result.data.map((row) => row.membership.membershipSeq),
    [ids[1], ids[0]],
  );
  assert.equal(result.data[0].customer.status, 'WITHDRAWN');
  assert.equal((await members(co, '?q=상태검색&status=ACTIVE')).total_count, 1);
  await pool.query(
    'UPDATE organizations SET deleted_at=clock_timestamp() WHERE organization_seq=$1',
    [co],
  );
  await error(await request(`/companies/${co}/members?q=상태검색`), 404, 'NOT_FOUND');
  await error(await request('/companies/2147483647/members?q=상태검색'), 404, 'NOT_FOUND');
});

test('manual registration validates IDs/body, preserves employee zeroes/case and refuses reassignment', async () => {
  const co = await company(),
    other = await company(),
    a = await customer(),
    b = await customer();
  await empty(await create(co, a.id, ' 001a '));
  assert.equal((await member(co, a.id)).employeeNo, '001a');
  await error(await create(co, b.id, '001a'), 409, 'DUPLICATE_RESOURCE');
  await error(await create(co, a.id, '002'), 409, 'DUPLICATE_RESOURCE');
  await error(await create(other, a.id, '001a'), 409, 'DUPLICATE_RESOURCE');
  await empty(await create(other, b.id, '001a'));
  const c = await customer();
  await empty(await create(co, c.id, '001A'));
  for (const input of [
    {},
    { customerSeq: a.id, employeeNo: ' ', role: 'MEMBER' },
    { customerSeq: String(a.id), employeeNo: '004', role: 'MEMBER' },
    { customerSeq: a.id, employeeNo: 123, role: 'MEMBER' },
    { customerSeq: a.id, employeeNo: '004', role: 'SYSTEM_ADMIN' },
    { customerSeq: a.id, employeeNo: '004', role: 'MEMBER', status: 'ACTIVE' },
  ])
    await error(
      await request(`/companies/${co}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify(input),
      }),
      400,
      'INVALID_REQUEST',
    );
  const id = (await member(co, a.id)).membershipSeq;
  for (const input of [
    {},
    { role: null },
    { status: null },
    { organizationSeq: other },
    { employeeNo: '004' },
    { customerSeq: b.id },
    { phoneNumber: phone() },
    { role: 'SYSTEM_ADMIN' },
    { status: 'PENDING' },
  ])
    await error(await patch(id, input), 400, 'INVALID_REQUEST');
  for (const idValue of ['0', '-1', '1.5', '2147483648', 'bad']) {
    await error(await request(`/companies/${idValue}/members`), 400, 'INVALID_REQUEST');
    await error(await patch(idValue, { role: 'MEMBER' }), 400, 'INVALID_REQUEST');
    await error(await remove(idValue), 400, 'INVALID_REQUEST');
  }
  await error(await create(2147483647, a.id), 404, 'NOT_FOUND');
  await error(await create(co, 2147483647), 404, 'NOT_FOUND');
  await error(await patch(2147483647, { role: 'MEMBER' }), 404, 'NOT_FOUND');
  await error(await remove(2147483647), 404, 'NOT_FOUND');
});

test('inactive/withdrawn checks prevent new registrations and activation without deleting records', async () => {
  const co = await company(),
    inactive = await company('INACTIVE'),
    a = await customer(),
    withdrawn = await customer('WITHDRAWN');
  await error(await create(inactive, a.id), 409, 'INVALID_STATE');
  await error(await create(co, withdrawn.id), 409, 'INVALID_STATE');
  await empty(await create(co, a.id));
  const m = await member(co, a.id);
  await empty(await patch(m.membershipSeq, { status: 'INACTIVE' }));
  await error(await create(await company(), a.id), 409, 'DUPLICATE_RESOURCE');
  await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [co]);
  await error(await patch(m.membershipSeq, { status: 'ACTIVE' }), 409, 'INVALID_STATE');
  assert.equal((await members(co)).data.length, 1);
  await pool.query("UPDATE organizations SET status='ACTIVE' WHERE organization_seq=$1", [co]);
  await empty(await patch(m.membershipSeq, { status: 'ACTIVE' }));
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [a.id]);
  await error(await patch(m.membershipSeq, { status: 'ACTIVE' }), 409, 'INVALID_STATE');
  await empty(await patch(m.membershipSeq, { status: 'INACTIVE' }));
  await empty(await remove(m.membershipSeq));
});

test('unlink deletes only membership, preserves customer/PIN/order and permits another company', async () => {
  const co = await company(),
    other = await company(),
    cu = await customer();
  await empty(await create(co, cu.id));
  const m = await member(co, cu.id);
  const order = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [cu.id])
  ).rows[0].order_seq;
  const address = {
    name: '수령인',
    phoneNumber: cu.phoneNumber,
    roadAddress: '테스트로 1',
    jibunAddress: '테스트동 1',
    detailAddress: '',
    dongName: '테스트동',
    postalCode: '12345',
  };
  const pin = (
    await pool.query(
      'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2::jsonb) RETURNING personal_pin_seq',
      [cu.id, JSON.stringify(address)],
    )
  ).rows[0].personal_pin_seq;
  await empty(await remove(m.membershipSeq));
  assert.deepEqual(await members(co), { data: [], hasNext: false, total_count: 0 });
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE customer_seq=$1', [cu.id])).rows[0]
      .count,
    '1',
  );
  assert.equal(
    (await pool.query('SELECT customer_seq FROM personal_pins WHERE personal_pin_seq=$1', [pin]))
      .rows[0].customer_seq,
    cu.id,
  );
  assert.equal(
    (await pool.query('SELECT customer_seq FROM orders WHERE order_seq=$1', [order])).rows[0]
      .customer_seq,
    cu.id,
  );
  await error(await remove(m.membershipSeq), 404, 'NOT_FOUND');
  await empty(await create(other, cu.id, 'NEW'));
  assert.notEqual((await member(other, cu.id)).membershipSeq, m.membershipSeq);
});

test('JSON batch creates new customers and links existing unaffiliated customers with default display/state', async () => {
  const co = await company(),
    existing = await customer(),
    number = phone();
  const content = [
    {
      employeeNo: '001a',
      name: ' 김,민수 ',
      phoneNumber: number,
      departmentSeq: departments.get(co),
    },
    ...employees(co, `002,변경 고객,${existing.phoneNumber}`),
  ];
  await empty(await registerMany(co, content));
  const list = await members(co);
  assert.equal(list.data.length, 2);
  const linked = list.data.find((row) => row.customer.customerSeq === existing.id);
  assert.equal(linked.customer.name, '변경 고객');
  assert.equal(linked.membership.employeeNo, '002');
  const fresh = list.data.find((row) => row.customer.phoneNumber === number);
  assert.equal(fresh.customer.name, '김,민수');
  assert.equal(fresh.membership.employeeNo, '001a');
  for (const row of list.data) {
    assert.equal(row.membership.role, 'MEMBER');
    assert.equal(row.membership.status, 'ACTIVE');
    assert.equal(row.customer.status, 'ACTIVE');
  }
});

test('JSON batch updates existing employee name/phone while retaining IDs, representative/status and historical order snapshot', async () => {
  const co = await company(),
    cu = await customer(),
    omitted = await customer();
  await empty(await create(co, cu.id, '001', randomUUID(), 'ORG_ADMIN'));
  await empty(await create(co, omitted.id, '002'));
  const m = await member(co, cu.id);
  await empty(await patch(m.membershipSeq, { status: 'INACTIVE' }));
  const order = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [cu.id])
  ).rows[0].order_seq;
  await pool.query(
    'INSERT INTO order_parcels(order_seq,parcel_position,origin_name,origin_phone_number) VALUES($1,1,$2,$3)',
    [order, cu.name, cu.phoneNumber],
  );
  const next = phone();
  await empty(await registerMany(co, employees(co, `001,새 이름,${next}`)));
  const after = await member(co, cu.id);
  assert.equal(after.membershipSeq, m.membershipSeq);
  assert.equal(after.role, 'ORG_ADMIN');
  assert.equal(after.status, 'INACTIVE');
  const detail = await request('/customers/' + cu.id);
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).data, {
    customerSeq: cu.id,
    name: '새 이름',
    phoneNumber: next,
    status: 'ACTIVE',
    monthlyBillingEnabled: false,
    address: null,
  });
  assert.equal((await members(co)).data.length, 2);
  const old = (
    await pool.query(
      'SELECT origin_name,origin_phone_number FROM order_parcels WHERE order_seq=$1',
      [order],
    )
  ).rows[0];
  assert.deepEqual(old, { origin_name: cu.name, origin_phone_number: cu.phoneNumber });
  await empty(await registerMany(co, employees(co, `001,새 이름,${next}`)));
  assert.equal((await member(co, cu.id)).membershipSeq, m.membershipSeq);
  const blocked = await request('/customers/' + cu.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone() }),
  });
  await error(blocked, 400, 'INVALID_REQUEST');
});

test('JSON batch validates the whole batch before changes and never echoes bad phone/name fields', async () => {
  const co = await company(),
    number = phone();
  for (const content of [
    employees(co, `001,PrivateName,${number}\n001,Other,${phone()}`),
    employees(co, `001,PrivateName,${number}\n002,Other,${number}`),
    employees(co, `001,PrivateName,${number}\n002,Other,010-bad`),
  ]) {
    const body = await error(await registerMany(co, content), 400, 'INVALID_REQUEST');
    assert.ok(!JSON.stringify(body).includes('PrivateName'));
    assert.ok(!JSON.stringify(body).includes(number));
    assert.equal((await members(co)).data.length, 0);
    assert.equal(
      (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
        .count,
      '0',
    );
  }
});

test('JSON batch rejects other-company membership, another employee number and phone ownership conflicts atomically', async () => {
  const co = await company(),
    other = await company(),
    a = await customer(),
    b = await customer();
  await empty(await create(co, a.id, '001'));
  await empty(await create(other, b.id, 'OTHER'));
  const number = phone();
  for (const [row, reason] of [
    [`002,Other,${b.phoneNumber}`, 'OTHER_COMPANY_MEMBERSHIP'],
    [`002,Other,${a.phoneNumber}`, 'EMPLOYEE_NO_CONFLICT'],
    [`001,Other,${b.phoneNumber}`, 'PHONE_NUMBER_CONFLICT'],
  ]) {
    const body = await error(
      await registerMany(co, employees(co, `NEW,새 고객,${number}\n` + row)),
      422,
      'VALIDATION_FAILED',
    );
    assert.ok(body.error.details.some((item) => item.reason === reason));
    assert.equal(
      (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
        .count,
      '0',
    );
    assert.equal((await member(co, a.id)).employeeNo, '001');
  }
});

test('JSON batch refuses withdrawn customers and inactive companies without reviving or partially saving rows', async () => {
  const co = await company(),
    inactive = await company('INACTIVE'),
    cu = await customer('WITHDRAWN');
  const body = await error(
    await registerMany(co, employees(co, `001,신규,${phone()}\n002,탈퇴,${cu.phoneNumber}`)),
    422,
    'VALIDATION_FAILED',
  );
  assert.ok(body.error.details.some((item) => item.reason === 'CUSTOMER_WITHDRAWN'));
  assert.equal((await members(co)).data.length, 0);
  await error(
    await registerMany(inactive, employees(inactive, `001,신규,${phone()}`)),
    409,
    'INVALID_STATE',
  );
  assert.equal(
    (await pool.query('SELECT status FROM customers WHERE customer_seq=$1', [cu.id])).rows[0]
      .status,
    'WITHDRAWN',
  );
  const existing = await customer();
  await empty(await create(co, existing.id, '003'));
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [existing.id]);
  await error(
    await registerMany(co, employees(co, `003,복구 시도,${phone()}`)),
    422,
    'VALIDATION_FAILED',
  );
});

test('employee JSON accepts more than the general 100 KiB limit on its own route', async () => {
  const co = await company();
  const name = '직'.repeat(40000);
  const number = phone();
  await empty(await registerMany(co, [{ employeeNo: 'LARGE', name, phoneNumber: number }]));
  assert.equal(
    (await pool.query('SELECT name FROM customers WHERE phone_number=$1', [number])).rows[0].name,
    name,
  );
});

test('single JSON and mixed customer-reference batches support optional departments atomically', async () => {
  const co = (
    await pool.query(
      "INSERT INTO organizations(name,status) VALUES('부서 없는 기업','ACTIVE') RETURNING organization_seq",
    )
  ).rows[0].organization_seq;
  const existing = await customer();
  const post = (input) =>
    request(`/companies/${co}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  await empty(await post({ employeeNo: '001', name: '신규 직원', phoneNumber: phone() }));
  await empty(
    await post({
      items: [
        { customerSeq: existing.id, employeeNo: '002', role: 'ORG_ADMIN', departmentSeq: null },
        { employeeNo: '003', name: '또 다른 직원', phoneNumber: phone() },
      ],
    }),
  );
  assert.equal((await members(co)).data.length, 3);
  for (const row of (await members(co)).data) assert.equal(row.membership.departmentSeq, null);
  const another = await customer();
  const number = phone();
  await error(
    await post({
      items: [
        { employeeNo: '004', name: '롤백 직원', phoneNumber: number },
        { customerSeq: another.id, employeeNo: '002', role: 'MEMBER' },
      ],
    }),
    409,
    'DUPLICATE_RESOURCE',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
      .count,
    '0',
  );
  assert.equal((await members(co)).data.length, 3);
  const withDept = await company();
  const person = await customer();
  await empty(await create(withDept, person.id));
  const m = await member(withDept, person.id);
  await empty(await patch(m.membershipSeq, { departmentSeq: null }));
  assert.equal((await member(withDept, person.id)).departmentSeq, null);
  await empty(
    await registerMany(withDept, [
      { employeeNo: '001', name: '보존 직원', phoneNumber: person.phoneNumber },
    ]),
  );
  assert.equal((await member(withDept, person.id)).departmentSeq, null);
  await empty(await patch(m.membershipSeq, { departmentSeq: departments.get(withDept) }));
  await empty(
    await registerMany(withDept, [
      { employeeNo: '001', name: '보존 직원', phoneNumber: person.phoneNumber },
    ]),
  );
  assert.equal((await member(withDept, person.id)).departmentSeq, departments.get(withDept));
});

test('repeated registration conflicts after restart and unlink permits a new registration', async () => {
  const co = await company(),
    cu = await customer();
  await empty(await create(co, cu.id));
  const m = await member(co, cu.id);
  const restarted = await start();
  await error(
    await create(co, cu.id, '001', undefined, 'MEMBER', await restarted.getUrl()),
    409,
    'DUPLICATE_RESOURCE',
  );
  await empty(await remove(m.membershipSeq));
  await empty(await create(co, cu.id));
  assert.notEqual((await member(co, cu.id)).membershipSeq, m.membershipSeq);
});

test('membership writes wait before returning a bounded lock timeout without a request key', async () => {
  const co = await company(),
    cu = await customer(),
    other = await customer();
  await empty(await create(co, cu.id));
  const m = await member(co, cu.id),
    lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await repository.lockWrites(lock);
    const started = Date.now();
    const responses = await Promise.all([
      create(co, other.id, '002'),
      patch(m.membershipSeq, { role: 'ORG_ADMIN' }),
      registerMany(co, employees(co, '003,New,' + phone())),
    ]);
    assert.ok(Date.now() - started >= 1500);
    for (const response of responses) await error(response, 409, 'REQUEST_IN_PROGRESS');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  await empty(await patch(m.membershipSeq, { role: 'ORG_ADMIN' }));
  await empty(await create(co, other.id, '002'));
});

test('concurrent JSON batches keep one customer/membership and audit each successful import', async () => {
  const co = await company(),
    number = phone(),
    key = undefined,
    content = employees(co, `001,동시 고객,${number}`);
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) => registerMany(co, content, key, i % 2 ? base : baseB)),
  );
  assert.ok(responses.some((response) => response.status === 204));
  for (const response of responses) assert.equal(response.status, 204);
  await empty(await registerMany(co, content, key));
  assert.equal((await members(co)).data.length, 1);
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
      .count,
    '1',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM audit_logs WHERE action='MEMBERS_IMPORTED' AND target_seq=$1 AND result='SUCCESS'",
        [co],
      )
    ).rows[0].count,
    String(responses.filter((response) => response.status === 204).length + 1),
  );
});

test('concurrent companies cannot acquire the same phone/customer and retries never move the winner', async () => {
  const co = await company(),
    other = await company(),
    number = phone(),
    content = employees(co, `001,경합 고객,${number}`);
  const responses = await Promise.all([
    registerMany(co, content),
    registerMany(other, employees(other, `001,경합 고객,${number}`), randomUUID(), baseB),
  ]);
  assert.equal(responses.filter((response) => response.status === 204).length, 1);
  for (const response of responses) assert.ok([204, 409, 422].includes(response.status));
  assert.equal((await members(co)).data.length + (await members(other)).data.length, 1);
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
      .count,
    '1',
  );
  const loser = (await members(co)).data.length ? other : co;
  await error(
    await registerMany(loser, employees(loser, `001,경합 고객,${number}`)),
    422,
    'VALIDATION_FAILED',
  );
});

test('JSON batch audit failure rolls back changed customers, new customers and memberships', async () => {
  const co = await company(),
    cu = await customer();
  await empty(await create(co, cu.id));
  const newPhone = phone(),
    otherPhone = phone();
  const content = employees(co, '001,Changed,' + newPhone + '\n002,New,' + otherPhone);
  content[0].role = 'ORG_ADMIN';
  await pool.query(
    "CREATE FUNCTION fail_member_batch_audit_37() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='MEMBERS_IMPORTED' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$",
  );
  try {
    await pool.query(
      'CREATE TRIGGER fail_member_batch_audit_37 BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_member_batch_audit_37()',
    );
    await error(await registerMany(co, content), 500, 'INTERNAL_ERROR');
    const old = (
      await pool.query('SELECT name,phone_number FROM customers WHERE customer_seq=$1', [cu.id])
    ).rows[0];
    assert.deepEqual(old, { name: cu.name, phone_number: cu.phoneNumber });
    assert.equal((await members(co)).data.length, 1);
    assert.equal((await member(co, cu.id)).role, 'MEMBER');
    assert.equal(
      (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [otherPhone]))
        .rows[0].count,
      '0',
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_logs WHERE action='MEMBERS_IMPORTED' AND target_seq=$1 AND result='SUCCESS'",
          [co],
        )
      ).rows[0].count,
      '0',
    );
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_member_batch_audit_37 ON audit_logs');
    await pool.query('DROP FUNCTION fail_member_batch_audit_37()');
  }
  await empty(await registerMany(co, content));
  assert.equal((await members(co)).data.length, 2);
  assert.equal((await member(co, cu.id)).role, 'ORG_ADMIN');
});

test('audit failure rolls back representative/status changes and unlink, recording only the failed attempt', async () => {
  const co = await company(),
    cu = await customer();
  await empty(await create(co, cu.id));
  const m = await member(co, cu.id);
  await pool.query(
    "CREATE FUNCTION public.fail_members_audit_37() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_type='MEMBERSHIP' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$",
  );
  try {
    await pool.query(
      'CREATE TRIGGER fail_members_audit_37 BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_members_audit_37()',
    );
    await error(
      await patch(m.membershipSeq, { role: 'ORG_ADMIN', status: 'INACTIVE' }),
      500,
      'INTERNAL_ERROR',
    );
    await error(await remove(m.membershipSeq), 500, 'INTERNAL_ERROR');
    const after = await member(co, cu.id);
    assert.equal(after.role, 'MEMBER');
    assert.equal(after.status, 'ACTIVE');
    const failures = await pool.query(
      "SELECT action,result FROM audit_logs WHERE target_type='MEMBERSHIP' AND target_seq=$1 AND result='FAILED' ORDER BY audit_log_seq",
      [m.membershipSeq],
    );
    assert.deepEqual(failures.rows, [
      { action: 'MEMBERSHIP_UPDATED', result: 'FAILED' },
      { action: 'MEMBERSHIP_REMOVED', result: 'FAILED' },
    ]);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_members_audit_37 ON audit_logs');
    await pool.query('DROP FUNCTION public.fail_members_audit_37()');
  }
});

test('JSON batch rechecks customer status after acquiring a row locked by a concurrent withdrawal', async () => {
  const co = await company(),
    cu = await customer(),
    newPhone = phone();
  await empty(await create(co, cu.id));
  const lock = await pool.connect();
  let pending,
    committed = false;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT customer_seq FROM customers WHERE customer_seq=$1 FOR UPDATE', [
      cu.id,
    ]);
    pending = registerMany(co, employees(co, `001,변경 시도,${newPhone}`));
    let waiting = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT customer_seq FROM customers WHERE customer_seq=ANY%') AS waiting",
      );
      if (result.rows[0].waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true);
    await lock.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [cu.id]);
    await lock.query('COMMIT');
    committed = true;
    await error(await pending, 422, 'VALIDATION_FAILED');
    const after = (
      await pool.query('SELECT status,phone_number FROM customers WHERE customer_seq=$1', [cu.id])
    ).rows[0];
    assert.deepEqual(after, { status: 'WITHDRAWN', phone_number: cu.phoneNumber });
  } finally {
    if (!committed) await lock.query('ROLLBACK');
    lock.release();
    if (pending) await pending;
  }
});

test('inline employee updates preserve an omitted role, membership identity, status and department', async () => {
  const co = await company(),
    cu = await customer();
  await empty(await create(co, cu.id, '001', undefined, 'ORG_ADMIN'));
  const original = await member(co, cu.id);
  await empty(await patch(original.membershipSeq, { status: 'INACTIVE' }));
  const input = { employeeNo: '001', name: '갱신 사원', phoneNumber: phone() };
  await empty(await registerMany(co, [input]));
  const omitted = await member(co, cu.id);
  assert.deepEqual(omitted, { ...original, status: 'INACTIVE' });
  await empty(await registerMany(co, [{ ...input, role: 'MEMBER' }]));
  assert.deepEqual(await member(co, cu.id), { ...omitted, role: 'MEMBER' });
});

test('member payment permissions support atomic single and batch changes without changing account status', async () => {
  const org = await company();
  const first = await customer(),
    second = await customer();
  await empty(await create(org, first.id, 'PAY-1'));
  await empty(await create(org, second.id, 'PAY-2'));
  const a = await member(org, first.id);
  const b = await member(org, second.id);
  assert.equal(a.monthlyBillingEnabled, true);
  assert.equal(a.groupBillingEnabled, false);
  const body = {
    membershipSeqs: [a.membershipSeq, b.membershipSeq],
    monthlyBillingEnabled: false,
    groupBillingEnabled: true,
  };
  const batch = (data) =>
    request('/companies/' + org + '/members', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  await empty(await batch(body));
  for (const id of [first.id, second.id]) {
    const current = await member(org, id);
    assert.equal(current.monthlyBillingEnabled, false);
    assert.equal(current.groupBillingEnabled, true);
    assert.equal(current.status, 'ACTIVE');
  }
  await error(
    await batch({
      ...body,
      membershipSeqs: [a.membershipSeq, 2147483647],
      monthlyBillingEnabled: true,
    }),
    404,
    'NOT_FOUND',
  );
  assert.equal((await member(org, first.id)).monthlyBillingEnabled, false);
  await empty(await patch(a.membershipSeq, { monthlyBillingEnabled: true }));
  assert.equal((await member(org, first.id)).monthlyBillingEnabled, true);
  const audits = await pool.query(
    "SELECT count(*)::int AS n FROM audit_logs WHERE action='MEMBERSHIP_UPDATED' AND target_seq=ANY($1::int[]) AND result='SUCCESS'",
    [[a.membershipSeq, b.membershipSeq]],
  );
  assert.equal(audits.rows[0].n, 3);
});
