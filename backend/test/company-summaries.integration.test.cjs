require('reflect-metadata');
const { before, after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestPool, startTestApp } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const pool = createTestPool();
const apps = [];
let app, base, cookie;
before(async () => migrate(pool));
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});

describe('administrator company and department summaries', () => {
  before(async () => {
    process.env.SWAGGER_ENABLED = 'false';
    process.env.CORS_ORIGINS = 'http://localhost:5173';
    const { hashPassword } = require('../dist/auth/password');
    const loginId = 'summary' + randomUUID().replaceAll('-', '').slice(0, 10);
    const password = 'summary-test-only-password';
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'요약 검증',$2,'SYSTEM_ADMIN','ACTIVE')",
      [loginId, await hashPassword(password)],
    );
    app = await startTestApp(apps);
    base = await app.getUrl();
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginId, password }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
  });
  async function request(path, method = 'GET', body, authenticated = true) {
    const response = await fetch(base + '/api' + path, {
      method,
      headers: {
        Origin: 'http://localhost:5173',
        'Content-Type': 'application/json',
        ...(authenticated ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  async function company() {
    const created = await request('/companies', 'POST', { name: '요약 ' + randomUUID() });
    assert.equal(created.status, 201);
    return created.body.data.organizationSeq;
  }
  async function department(id, name) {
    const created = await request(`/companies/${id}/departments`, 'POST', { name });
    assert.equal(created.status, 201);
    return created.body.data.departmentSeq;
  }
  async function member(id, departmentSeq, status = 'ACTIVE', role = 'MEMBER') {
    const customer = (
      await pool.query(
        "INSERT INTO customers(name,phone_number,status) VALUES('요약 사원',$1,'ACTIVE') RETURNING customer_seq",
        ['016' + randomInt(10000000, 100000000)],
      )
    ).rows[0].customer_seq;
    return (
      await pool.query(
        'INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status,department_seq) VALUES($1,$2,$3,$4,$5,$6) RETURNING membership_seq',
        [customer, id, randomUUID(), role, status, departmentSeq],
      )
    ).rows[0].membership_seq;
  }
  test('lists and company detail count active members once, include unassigned staff, and retain pagination totals', async () => {
    const id = await company();
    const a = await department(id, '첫 부서');
    const b = await department(id, '빈 부서');
    await member(id, a);
    await member(id, a, 'ACTIVE', 'ORG_ADMIN');
    await member(id, a, 'INACTIVE');
    await member(id, null);
    const other = await company();
    await member(other, null);
    const detail = (await request(`/companies/${id}`)).body.data;
    assert.equal(detail.memberCount, 3);
    assert.ok(Number.isFinite(Date.parse(detail.createdAt)));
    const list = (await request('/companies?limit=1')).body;
    assert.equal(list.data.length, 1);
    assert.equal(list.data[0].memberCount, 1);
    assert.ok(list.total_count >= 2);
    const departments = (await request(`/companies/${id}/departments`)).body;
    assert.equal(departments.total_count, 2);
    assert.deepEqual(
      departments.data.map((r) => [r.departmentSeq, r.memberCount]),
      [
        [a, 2],
        [b, 0],
      ],
    );
    assert.ok(departments.data.every((r) => Number.isFinite(Date.parse(r.createdAt))));
    const beyond = (await request(`/companies/${id}/departments?offset=100`)).body;
    assert.deepEqual(beyond, { data: [], hasNext: false, total_count: 2 });
    assert.equal((await request(`/companies/${id}`, 'PATCH', { status: 'INACTIVE' })).status, 204);
    assert.equal((await request(`/companies/${id}`)).body.data.memberCount, 3);
  });
  test('member status, department transfer, unassignment and deletion update counts without rewriting registration dates', async () => {
    const id = await company();
    const a = await department(id, '이전 부서');
    const b = await department(id, '이동 부서');
    const employee = await member(id, a);
    const original = (await request(`/companies/${id}`)).body.data.createdAt;
    assert.equal(
      (await request(`/members/${employee}`, 'PATCH', { departmentSeq: b })).status,
      204,
    );
    assert.deepEqual(
      (await request(`/companies/${id}/departments`)).body.data.map((r) => r.memberCount),
      [0, 1],
    );
    assert.equal(
      (await request(`/members/${employee}`, 'PATCH', { status: 'INACTIVE' })).status,
      204,
    );
    assert.equal((await request(`/companies/${id}`)).body.data.memberCount, 0);
    assert.equal(
      (await request(`/members/${employee}`, 'PATCH', { status: 'ACTIVE', departmentSeq: null }))
        .status,
      204,
    );
    assert.equal((await request(`/companies/${id}`)).body.data.memberCount, 1);
    assert.deepEqual(
      (await request(`/companies/${id}/departments`)).body.data.map((r) => r.memberCount),
      [0, 0],
    );
    assert.equal((await request(`/members/${employee}`, 'DELETE')).status, 204);
    const final = (await request(`/companies/${id}`)).body.data;
    assert.equal(final.memberCount, 0);
    assert.equal(final.createdAt, original);
  });
});
