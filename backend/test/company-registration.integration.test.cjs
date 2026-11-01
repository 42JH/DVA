require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./helpers/migrations.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const { DatabaseService } = require('../dist/database/database.service');
const { MembersRepository } = require('../dist/members/members.repository');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
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
let app, base;
before(async () => {
  await migrate(pool);
  const password = 'registration-test-only-password';
  const hash = await hashPassword(password);
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log() {} });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const loginId = 'reg' + randomUUID().replaceAll('-', '').slice(0, 16);
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'통합 등록 검증',$2,$3,'ACTIVE')",
      [loginId, hash, role],
    );
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId, password }),
    });
    assert.equal(response.status, 200);
    cookies.push(response.headers.get('set-cookie').split(';')[0]);
  }
});
after(async () => {
  if (app) await app.close();
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

test('a company can create departments without employees', async () => {
  const response = await post({ name: companyName(), departments: [{ name: '부서' }] });
  assert.equal(response.status, 201);
  const id = (await response.json()).data.organizationSeq;
  assert.equal((await get(`/api/companies/${id}/departments`)).total_count, 1);
  assert.equal((await get(`/api/companies/${id}/members`)).total_count, 0);
});

test('missing sessions and forbidden Origins cannot create any part of a registration', async () => {
  const before = await counts();
  const input = { name: companyName(), departments: [{ name: '부서' }], members: [employee()] };
  await error(await post(input, { session: null }), 401, 'UNAUTHORIZED');
  await error(await post(input, { from: 'https://forbidden.invalid' }), 403, 'FORBIDDEN');
  assert.deepEqual(await counts(), before);
});

test('nested validation, duplicate identifiers and undeclared departments reject before creating a company', async () => {
  const before = await counts();
  const member = employee();
  for (const [input, status, code, field] of [
    [
      { name: companyName(), members: [{ ...member, role: 'SYSTEM_ADMIN' }] },
      400,
      'INVALID_REQUEST',
      'members[0].role',
    ],
    [
      { name: companyName(), members: [member, { ...member, phoneNumber: phone() }] },
      400,
      'INVALID_REQUEST',
      'members[1].employeeNo',
    ],
    [
      { name: companyName(), departments: [{ name: '부서' }, { name: ' 부서 ' }] },
      400,
      'INVALID_REQUEST',
      'departments[1].name',
    ],
    [
      { name: companyName(), members: [{ ...member, departmentName: '없는 부서' }] },
      422,
      'VALIDATION_FAILED',
      'members[0].departmentName',
    ],
  ]) {
    const body = await error(await post(input), status, code);
    assert.ok(body.error.details.some((detail) => detail.field === field));
  }
  assert.deepEqual(await counts(), before);
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

test('withdrawn customers cannot leave a newly created company or departments behind', async () => {
  const number = phone();
  await pool.query(
    "INSERT INTO customers(name,phone_number,status) VALUES('탈퇴 고객',$1,'WITHDRAWN')",
    [number],
  );
  const before = await counts();
  const body = await error(
    await post({
      name: companyName(),
      departments: [{ name: '부서' }],
      members: [employee({ phoneNumber: number })],
    }),
    422,
    'VALIDATION_FAILED',
  );
  assert.equal(body.error.details[0].reason, 'CUSTOMER_WITHDRAWN');
  assert.deepEqual(await counts(), before);
});

test('a failure after employee persistence rolls back all created records and reused customer changes', async () => {
  const number = phone();
  const customer = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('원래 이름',$1,'ACTIVE') RETURNING customer_seq",
      [number],
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
          }),
          employee({ employeeNo: '002' }),
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
    names.map((name) =>
      post({
        name,
        departments: [{ name: '부서' }],
        members: [{ ...member, departmentName: '부서' }],
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
    await post({ name: '가'.repeat(40000), phoneNumber: phone() }, { path: '/api/customers' }),
    413,
    'PAYLOAD_TOO_LARGE',
  );
  assert.deepEqual(await counts(), before);
});
