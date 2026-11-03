require('reflect-metadata');
const { before, after, describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createTestPool } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
const pool = createTestPool();
let app, base, cookie;
before(async () => migrate(pool));
after(async () => {
  if (app) await app.close();
  await pool.end();
});

test('migration restores only successful creation timestamps and leaves unknown legacy dates null', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE organizations DROP COLUMN created_at');
    await client.query('ALTER TABLE departments DROP COLUMN created_at');
    const organizations = (
      await client.query(
        "INSERT INTO organizations(name,status) VALUES('알려진 등록일','ACTIVE'),('등록일 미상','ACTIVE') RETURNING organization_seq",
      )
    ).rows;
    const departments = (
      await client.query(
        "INSERT INTO departments(organization_seq,name) VALUES($1,'알려진 부서'),($1,'등록일 미상 부서') RETURNING department_seq",
        [organizations[0].organization_seq],
      )
    ).rows;
    for (const [type, id, action] of [
      ['ORGANIZATION', organizations[0].organization_seq, 'ORGANIZATION_CREATED'],
      ['DEPARTMENT', departments[0].department_seq, 'DEPARTMENT_CREATED'],
    ])
      for (const [result, date] of [
        ['FAILED', '2026-01-01T00:00:00Z'],
        ['SUCCESS', '2026-05-22T01:02:03Z'],
        ['SUCCESS', '2026-06-01T00:00:00Z'],
      ])
        await client.query(
          "INSERT INTO audit_logs(actor_type,actor_seq,target_type,target_seq,action,result,request_id,occurred_at,metadata) VALUES('SYSTEM',NULL,$1,$2,$3,$4,$5,$6,'{}'::jsonb)",
          [type, id, action, result, randomUUID(), date],
        );
    await client.query(
      readFileSync(join(__dirname, '../migrations/033-organization-created-at.sql'), 'utf8'),
    );
    for (const [table, key, ids] of [
      ['organizations', 'organization_seq', organizations.map((r) => r.organization_seq)],
      ['departments', 'department_seq', departments.map((r) => r.department_seq)],
    ]) {
      const rows = (
        await client.query(
          `SELECT created_at FROM ${table} WHERE ${key}=ANY($1::int[]) ORDER BY ${key}`,
          [ids],
        )
      ).rows;
      assert.equal(rows[0].created_at.toISOString(), '2026-05-22T01:02:03.000Z');
      assert.equal(rows[1].created_at, null);
    }
    const fresh = (
      await client.query(
        "INSERT INTO organizations(name,status) VALUES('신규 등록일','ACTIVE') RETURNING organization_seq,created_at",
      )
    ).rows[0];
    assert.ok(fresh.created_at instanceof Date);
    assert.ok(
      (
        await client.query(
          "INSERT INTO departments(organization_seq,name) VALUES($1,'신규 부서') RETURNING created_at",
          [fresh.organization_seq],
        )
      ).rows[0].created_at instanceof Date,
    );
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

describe('administrator company and department summaries', () => {
  before(async () => {
    process.env.SWAGGER_ENABLED = 'true';
    process.env.CORS_ORIGINS = 'http://localhost:5173';
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../dist/app.module');
    const { configureApplication } = require('../dist/configure-application');
    const { hashPassword } = require('../dist/auth/password');
    const loginId = 'summary' + randomUUID().replaceAll('-', '').slice(0, 10);
    const password = 'summary-test-only-password';
    await pool.query(
      "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'요약 검증',$2,'SYSTEM_ADMIN','ACTIVE')",
      [loginId, await hashPassword(password)],
    );
    app = await NestFactory.create(AppModule, { logger: false });
    configureApplication(app, { log: () => {} });
    await app.listen(0, '127.0.0.1');
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
  test('legacy unknown dates remain explicit null and names/settings updates preserve known dates', async () => {
    const id = await company();
    const d = await department(id, '등록일 검증');
    await pool.query(
      "UPDATE organizations SET created_at='2026-05-22T01:02:03Z' WHERE organization_seq=$1",
      [id],
    );
    await pool.query('UPDATE departments SET created_at=NULL WHERE department_seq=$1', [d]);
    assert.equal((await request(`/companies/${id}`, 'PATCH', { name: '등록일 유지' })).status, 204);
    assert.equal(
      (await request(`/departments/${d}`, 'PATCH', { name: '등록일 미상 유지' })).status,
      204,
    );
    assert.equal(
      (await request(`/companies/${id}`)).body.data.createdAt,
      '2026-05-22T01:02:03.000Z',
    );
    const summary = (await request(`/companies/${id}/departments`)).body.data[0];
    assert.equal(summary.createdAt, null);
    assert.equal(summary.memberCount, 0);
    await pool.query('UPDATE organizations SET created_at=NULL WHERE organization_seq=$1', [id]);
    assert.equal((await request(`/companies/${id}`)).body.data.createdAt, null);
  });
  test('summary fields stay administrator-only and shared AI context schemas retain their original shape', async () => {
    const id = await company();
    for (const path of ['/companies', `/companies/${id}`, `/companies/${id}/departments`])
      assert.equal((await request(path, 'GET', undefined, false)).status, 401);
    const document = await (await fetch(base + '/api/docs-json')).json();
    for (const name of ['OrganizationSummaryDto', 'DepartmentSummaryDto']) {
      const schema = document.components.schemas[name];
      for (const field of ['memberCount', 'createdAt']) assert.ok(schema.required.includes(field));
      assert.equal(schema.properties.memberCount.type, 'integer');
      assert.equal(schema.properties.createdAt.format, 'date-time');
      assert.equal(schema.properties.createdAt.nullable, true);
    }
    for (const name of ['OrganizationResponseDto', 'DepartmentDto']) {
      assert.equal(document.components.schemas[name].properties.memberCount, undefined);
      assert.equal(document.components.schemas[name].properties.createdAt, undefined);
    }
    assert.equal(document.paths['/api/departments/{id}'].get, undefined);
  });
});
