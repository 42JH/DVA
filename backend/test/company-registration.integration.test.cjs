const customerAddress = require('./helpers/customer-address.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestSession, createTestPool, startTestApp } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'false';
process.env.CORS_ORIGINS = 'http://localhost:5173';

const { DatabaseService } = require('../dist/database/database.service');
const { MembersRepository } = require('../dist/members/members.repository');
const pool = createTestPool();
const apps = [];
const origin = 'http://localhost:5173';
const cookies = [];
const prefix = String(randomInt(1000, 10000));
let sequence = 0;
const phone = () => '019' + prefix + String(sequence++).padStart(4, '0');
const companyName = () => '통합 등록 검증 ' + randomUUID();
const employee = (extra = {}) => ({
  employeeNo: '001',
  name: '사원',
  phoneNumber: phone(),
  ...extra,
});
const address = (suffix) => ({
  roadAddress: '주소로 ' + suffix,
  jibunAddress: '주소동 ' + suffix,
  detailAddress: '101호',
  dongName: '주소동',
  postalCode: '01234',
});
let app, base;
before(async () => {
  await migrate(pool);
  app = await startTestApp(apps);
  base = await app.getUrl();
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const loginId = 'reg' + randomUUID().replaceAll('-', '').slice(0, 16);
    const { rows } = await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'통합 등록 검증',$2,$3,'ACTIVE') RETURNING admin_user_seq",
      [loginId, 'not-for-login', role],
    );
    cookies.push(await createTestSession(pool, rows[0].admin_user_seq));
  }
});
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});
const post = (input, { session = cookies[0], from = origin, path = '/api/companies' } = {}) =>
  fetch(base + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(session === null ? {} : { Cookie: session }),
      Origin: from,
    },
    body: JSON.stringify(input),
  });
async function get(path) {
  const response = await fetch(base + path, { headers: { Cookie: cookies[0] } });
  assert.equal(response.status, 200);
  return response.json();
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  return body;
}
async function counts() {
  return (
    await pool.query(`SELECT (SELECT count(*) FROM organizations)::int AS companies,
    (SELECT count(*) FROM departments)::int AS departments, (SELECT count(*) FROM customers)::int AS customers,
    (SELECT count(*) FROM memberships)::int AS memberships`)
  ).rows[0];
}

test('all active admin roles can register a company and employees; old and empty-array requests retain the 201 response', async () => {
  for (const session of cookies) {
    const response = await post({ name: companyName() }, { session });
    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.data), ['organizationSeq']);
    assert.ok(body.meta.requestId);
  }
  const response = await post({ name: companyName(), departments: [], members: [] });
  assert.equal(response.status, 201);
});

test('company, departments, customers, memberships and successful audits commit in exactly one transaction', async () => {
  const name = companyName(),
    representative = employee({ role: 'ORG_ADMIN', departmentName: ' 개발팀 ' });
  const database = app.get(DatabaseService),
    beforeTransactions = database.transactionStatistics.count;
  const response = await post({
    name,
    monthlyBillingEnabled: true,
    departments: [{ name: ' 개발팀 ', groupBillingEnabled: true }, { name: '지원팀' }],
    members: [
      representative,
      employee({ employeeNo: '002', departmentName: '지원팀' }),
      employee({ employeeNo: '003' }),
    ],
  });
  assert.equal(response.status, 201);
  assert.equal(database.transactionStatistics.count - beforeTransactions, 1);
  const body = await response.json(),
    id = body.data.organizationSeq;
  const company = (await get('/api/companies/' + id)).data;
  assert.equal(company.name, name);
  assert.equal(company.memberCount, 3);
  assert.equal(company.monthlyBillingEnabled, true);
  assert.ok(company.createdAt);
  const departments = (await get(`/api/companies/${id}/departments`)).data;
  assert.deepEqual(
    departments.map((row) => [row.name, row.memberCount]),
    [
      ['개발팀', 1],
      ['지원팀', 1],
    ],
  );
  assert.equal(departments[0].groupBillingEnabled, true);
  const members = (await get(`/api/companies/${id}/members`)).data.sort((a, b) =>
    a.membership.employeeNo.localeCompare(b.membership.employeeNo),
  );
  assert.deepEqual(
    members.map((row) => row.membership.role),
    ['ORG_ADMIN', 'MEMBER', 'MEMBER'],
  );
  assert.deepEqual(
    members.map((row) => row.membership.departmentSeq),
    [departments[0].departmentSeq, departments[1].departmentSeq, null],
  );
  const audits = await pool.query(
    "SELECT action FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' ORDER BY action",
    [body.meta.requestId],
  );
  assert.deepEqual(
    audits.rows.map((row) => row.action),
    ['DEPARTMENT_CREATED', 'DEPARTMENT_CREATED', 'MEMBERS_IMPORTED', 'ORGANIZATION_CREATED'],
  );
});

test('a company without departments can register representatives and reuse an unaffiliated customer', async () => {
  const number = phone();
  const existing = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('기존 고객',$1,'ACTIVE') RETURNING customer_seq",
      [number],
    )
  ).rows[0].customer_seq;
  const response = await post({
    name: companyName(),
    members: [employee({ phoneNumber: number, role: 'ORG_ADMIN', departmentName: null })],
  });
  assert.equal(response.status, 201);
  const id = (await response.json()).data.organizationSeq;
  const rows = (await get(`/api/companies/${id}/members`)).data;
  assert.equal(rows[0].customer.customerSeq, existing);
  assert.equal(rows[0].membership.departmentSeq, null);
  assert.equal(rows[0].membership.role, 'ORG_ADMIN');
  assert.equal((await get(`/api/companies/${id}/departments`)).total_count, 0);
});

test('company registration saves new and reused customer addresses in the same transaction and exposes personal usage', async () => {
  const number = phone();
  const existing = await post(
    { name: '기존 고객', phoneNumber: number, address: address('기존') },
    { path: '/api/customers' },
  );
  assert.equal(existing.status, 201);
  const customerSeq = (await existing.json()).data.customerSeq;
  const pinAddress = { ...address('PIN'), name: '수령인', phoneNumber: number };
  await pool.query('INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2)', [
    customerSeq,
    pinAddress,
  ]);
  const newAddress = address('신규');
  const incoming = [
    employee({
      phoneNumber: number,
      name: '수정 고객',
      address: address('수정'),
    }),
    employee({ employeeNo: '002', address: newAddress }),
  ];
  const database = app.get(DatabaseService),
    beforeTransactions = database.transactionStatistics.count;
  const response = await post({ name: companyName(), members: incoming });
  assert.equal(response.status, 201);
  assert.equal(database.transactionStatistics.count - beforeTransactions, 1);
  const id = (await response.json()).data.organizationSeq;
  const members = (await get(`/api/companies/${id}/members`)).data;
  assert.equal(
    members.find((row) => row.membership.employeeNo === '001').customer.customerSeq,
    customerSeq,
  );
  for (const input of incoming) {
    const member = members.find((row) => row.membership.employeeNo === input.employeeNo);
    const expectedAddress = input.address;
    assert.equal(member.customer.name, input.name);
    assert.deepEqual(member.customer.address, expectedAddress);
    const detail = (await get(`/api/customers/${member.customer.customerSeq}`)).data;
    assert.deepEqual(detail.address, expectedAddress);
    const context = (
      await (
        await post({ phoneNumber: input.phoneNumber }, { path: '/api/customers/context' })
      ).json()
    ).data;
    assert.equal(context.customer.customerSeq, member.customer.customerSeq);
    assert.deepEqual(context.customer.address, expectedAddress);
    assert.deepEqual(context.availableUsageTypes, ['PERSONAL', 'COMPANY']);
  }
  assert.deepEqual(
    (
      await pool.query('SELECT address_data FROM personal_pins WHERE customer_seq=$1', [
        customerSeq,
      ])
    ).rows[0].address_data,
    pinAddress,
  );
});

test('existing company member batches save all customer addresses and distinguish replacement, omission and null', async () => {
  const company = await post({ name: companyName() });
  assert.equal(company.status, 201);
  const id = (await company.json()).data.organizationSeq;
  const path = `/api/companies/${id}/members`;
  const old = employee({ role: 'ORG_ADMIN', address: address('최초') });
  assert.equal((await post(old, { path })).status, 204);
  const before = (await get(path)).data[0];
  const number = phone();
  const existing = await post(
    { address: customerAddress(), name: '미소속 고객', phoneNumber: number },
    { path: '/api/customers' },
  );
  assert.equal(existing.status, 201);
  const existingId = (await existing.json()).data.customerSeq;
  const items = [
    { ...old, role: undefined, address: address('교체') },
    employee({ employeeNo: '002', phoneNumber: number, address: address('연결') }),
    employee({
      employeeNo: '003',
      address: address('생성'),
    }),
    employee({ employeeNo: '004' }),
  ];
  const database = app.get(DatabaseService),
    beforeTransactions = database.transactionStatistics.count;
  assert.equal((await post({ items }, { path })).status, 204);
  assert.equal(database.transactionStatistics.count - beforeTransactions, 1);
  const members = (await get(path)).data;
  for (const input of items) {
    const member = members.find((row) => row.membership.employeeNo === input.employeeNo);
    const expectedAddress = input.address ?? null;
    assert.deepEqual(member.customer.address, expectedAddress);
  }
  const updated = members.find((row) => row.membership.employeeNo === '001');
  assert.equal(updated.customer.customerSeq, before.customer.customerSeq);
  assert.equal(updated.membership.membershipSeq, before.membership.membershipSeq);
  assert.equal(updated.membership.role, 'ORG_ADMIN');
  assert.equal(
    members.find((row) => row.membership.employeeNo === '002').customer.customerSeq,
    existingId,
  );
  const { address: _ignored, ...withoutAddress } = old;
  assert.equal((await post({ ...withoutAddress, name: '주소 유지' }, { path })).status, 204);
  assert.deepEqual(
    (await get(`/api/customers/${before.customer.customerSeq}`)).data.address,
    address('교체'),
  );
  const replacement = address('주소 교체');
  assert.equal((await post({ ...old, address: replacement }, { path })).status, 204);
  assert.deepEqual(
    (await get(`/api/customers/${before.customer.customerSeq}`)).data.address,
    replacement,
  );
  assert.equal((await post({ ...old, address: null }, { path })).status, 204);
  assert.equal((await get(`/api/customers/${before.customer.customerSeq}`)).data.address, null);
});

test('invalid addresses reject the whole registration before modifying an existing customer', async () => {
  const number = phone();
  const created = await post(
    { name: '기존 고객', phoneNumber: number, address: address('보존') },
    { path: '/api/customers' },
  );
  assert.equal(created.status, 201);
  const customerSeq = (await created.json()).data.customerSeq;
  const company = await post({ name: companyName() });
  const id = (await company.json()).data.organizationSeq;
  const rows = [
    employee({ phoneNumber: number, name: '거절될 변경', address: address('변경') }),
    employee({ employeeNo: '002', address: { ...address('오류'), longitude: 127 } }),
  ];
  const before = await counts();
  for (const [input, path, field] of [
    [{ name: companyName(), members: rows }, '/api/companies', 'members[1].address.longitude'],
    [{ items: rows }, `/api/companies/${id}/members`, 'items[1].address.longitude'],
  ]) {
    const body = await error(await post(input, { path }), 400, 'INVALID_REQUEST');
    assert.ok(body.error.details.some((detail) => detail.field === field));
    assert.deepEqual(await counts(), before);
    const detail = (await get(`/api/customers/${customerSeq}`)).data;
    assert.equal(detail.name, '기존 고객');
    assert.deepEqual(detail.address, address('보존'));
  }
});

test('existing membership conflicts roll back the newly inserted company, departments and success audits', async () => {
  const member = employee();
  assert.equal((await post({ name: companyName(), members: [member] })).status, 201);
  const before = await counts();
  const response = await post({
    name: companyName(),
    departments: [{ name: '부서' }],
    members: [employee(), { ...member, employeeNo: '002', departmentName: '부서' }],
  });
  const body = await error(response, 422, 'VALIDATION_FAILED');
  assert.deepEqual(body.error.details, [
    { field: 'members[1].phoneNumber', reason: 'OTHER_COMPANY_MEMBERSHIP' },
  ]);
  assert.deepEqual(await counts(), before);
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
        body.meta.requestId,
      ])
    ).rows[0].count,
    '0',
  );
});

test('a failure after employee persistence rolls back all created records and reused customer changes', async () => {
  const number = phone();
  const customer = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status,address_data) VALUES('원래 이름',$1,'ACTIVE',$2) RETURNING customer_seq",
      [number, address('원래')],
    )
  ).rows[0].customer_seq;
  const before = await counts();
  const repository = app.get(MembersRepository),
    original = repository.importRows;
  repository.importRows = async function (...args) {
    await original.apply(this, args);
    throw new Error('Test failure after membership writes');
  };
  let body;
  try {
    body = await error(
      await post({
        name: companyName(),
        departments: [{ name: '부서' }],
        members: [
          employee({
            phoneNumber: number,
            name: '바뀐 이름',
            role: 'ORG_ADMIN',
            departmentName: '부서',
            address: address('거절될 수정'),
          }),
          employee({ employeeNo: '002', address: address('거절될 생성') }),
        ],
      }),
      500,
      'INTERNAL_ERROR',
    );
  } finally {
    repository.importRows = original;
  }
  assert.deepEqual(await counts(), before);
  assert.equal(
    (await pool.query('SELECT name FROM customers WHERE customer_seq=$1', [customer])).rows[0].name,
    '원래 이름',
  );
  assert.deepEqual(
    (await pool.query('SELECT address_data FROM customers WHERE customer_seq=$1', [customer]))
      .rows[0].address_data,
    address('원래'),
  );
  assert.equal(
    (
      await pool.query("SELECT count(*) FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
        body.meta.requestId,
      ])
    ).rows[0].count,
    '0',
  );
});

test('concurrent company registrations sharing a phone have one winner and no orphan company', async () => {
  const member = employee(),
    names = [companyName(), companyName()];
  const responses = await Promise.all(
    names.map((name, index) =>
      post({
        name,
        departments: [{ name: '부서' }],
        members: [{ ...member, departmentName: '부서', address: address(String(index)) }],
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 422]);
  assert.equal(
    (await pool.query('SELECT count(*) FROM organizations WHERE name=ANY($1::text[])', [names]))
      .rows[0].count,
    '1',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [member.phoneNumber]))
      .rows[0].count,
    '1',
  );
  assert.deepEqual(
    (
      await pool.query('SELECT address_data FROM customers WHERE phone_number=$1', [
        member.phoneNumber,
      ])
    ).rows[0].address_data,
    address(String(responses.findIndex((response) => response.status === 201))),
  );
});

test('membership lock timeouts preserve 409 semantics and roll back the enclosing company registration', async () => {
  const before = await counts(),
    client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(20261027,37)');
    await error(
      await post({ name: companyName(), departments: [{ name: '부서' }], members: [employee()] }),
      409,
      'REQUEST_IN_PROGRESS',
    );
    assert.deepEqual(await counts(), before);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('company POST accepts a 1000-employee body above 100 KiB and rejects bodies above 1 MiB', async () => {
  const members = Array.from({ length: 1000 }, (_, index) =>
    employee({
      employeeNo: String(index),
      name: '검증사원'.repeat(15),
      role: index % 2 ? 'MEMBER' : 'ORG_ADMIN',
    }),
  );
  const input = { name: companyName(), members };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > 100 * 1024);
  const response = await post(input, { path: '/api/companies/' });
  assert.equal(response.status, 201);
  const id = (await response.json()).data.organizationSeq;
  assert.equal((await get('/api/companies/' + id)).data.memberCount, 1000);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM memberships WHERE organization_seq=$1 AND role='ORG_ADMIN'",
        [id],
      )
    ).rows[0].count,
    '500',
  );
  const before = await counts();
  await error(await post({ name: '가'.repeat(400000) }), 413, 'PAYLOAD_TOO_LARGE');
  await error(
    await post(
      { address: customerAddress(), name: '가'.repeat(40000), phoneNumber: phone() },
      { path: '/api/customers' },
    ),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  assert.deepEqual(await counts(), before);
});
