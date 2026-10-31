const { testMembership } = require('./helpers/membership.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { migrate } = require('./helpers/migrations.cjs');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
let app, appB, base, baseB, adminA, adminB, hash, sessionA;
const apps = [];
const cookies = new Map();
const password = 'company-test-only-password';
const mutationHeaders = { Origin: 'http://localhost:5173' };

async function start() {
  const application = await NestFactory.create(AppModule, { logger: false });
  apps.push(application);
  configureApplication(application, { log: () => {} });
  await application.listen(0, '127.0.0.1');
  return application;
}
async function login(loginId, host = base) {
  const response = await fetch(host + '/api/auth/login', {
    method: 'POST',
    headers: { ...mutationHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function account(loginId, role = 'OPERATOR', status = 'ACTIVE') {
  const result = await pool.query(
    'INSERT INTO admin_users (login_id,name,password_hash,role,status) VALUES ($1,$2,$3,$4,$5) RETURNING admin_user_seq',
    [loginId, '기업 테스트', hash, role, status],
  );
  return result.rows[0].admin_user_seq;
}
before(async () => {
  await migrate(pool);
  hash = await hashPassword(password);
  adminA = await account('companyTestA');
  adminB = await account('companyTestB', 'SYSTEM_ADMIN');
  app = await start();
  appB = await start();
  base = await app.getUrl();
  baseB = await appB.getUrl();
  sessionA = await login('companyTestA');
  cookies.set(base, sessionA);
  cookies.set(baseB, await login('companyTestB', baseB));
});
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});

const request = (path, options = {}, host = base) =>
  fetch(host + '/api/companies' + path, {
    ...options,
    headers: Object.fromEntries(
      Object.entries({ ...mutationHeaders, Cookie: cookies.get(host), ...options.headers }).filter(
        ([, value]) => value !== undefined,
      ),
    ),
  });
const create = (name, key = undefined, host = base, extra = {}) =>
  request(
    '',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ name, ...extra }),
    },
    host,
  );
const patch = (id, body) =>
  request('/' + id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('every company operation rejects missing, forged and malformed sessions before writes', async () => {
  const count = (await pool.query('SELECT count(*) FROM organizations')).rows[0].count;
  for (const cookie of [undefined, 'dva_session=invalid', 'dva_session=' + 'a'.repeat(64)]) {
    for (const [method, path] of [
      ['GET', ''],
      ['POST', ''],
      ['GET', '/1'],
      ['PATCH', '/1'],
    ]) {
      const response = await request(path, {
        method,
        headers: { Cookie: cookie, 'X-Admin-User-Seq': String(adminA) },
      });
      assert.equal(response.status, 401, method + ' ' + path);
      assert.equal((await response.json()).error.code, 'UNAUTHORIZED');
    }
  }
  assert.equal((await pool.query('SELECT count(*) FROM organizations')).rows[0].count, count);
});

test('company writes require an allowed Origin even with a valid session', async () => {
  const id = (await (await create('CSRF 검증 기업')).json()).data.organizationSeq;
  for (const headers of [{ Origin: undefined }, { Origin: 'https://untrusted.invalid' }]) {
    for (const [method, path, body] of [
      ['POST', '', { name: 'CSRF 거절 기업' }],
      ['PATCH', '/' + id, { name: 'CSRF 거절 기업' }],
    ]) {
      const response = await request(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
          ...headers,
        },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'FORBIDDEN');
    }
  }
  assert.equal((await (await request('/' + id)).json()).data.name, 'CSRF 검증 기업');
  assert.equal(
    (await pool.query('SELECT count(*) FROM organizations WHERE name=$1', ['CSRF 거절 기업']))
      .rows[0].count,
    '0',
  );
});

test('all active administrator roles can register, list, read and update companies', async () => {
  await account('companySupervisor', 'SUPERVISOR');
  for (const cookie of [sessionA, cookies.get(baseB), await login('companySupervisor')]) {
    const name = '역할 검증 ' + randomUUID();
    const created = await request('', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify({ name }),
    });
    assert.equal(created.status, 201);
    const id = (await created.json()).data.organizationSeq;
    assert.equal((await request('/' + id, { headers: { Cookie: cookie } })).status, 200);
    const list = await request('?q=' + encodeURIComponent(name), { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data[0].organizationSeq, id);
    assert.equal(
      (
        await request('/' + id, {
          method: 'PATCH',
          headers: { Cookie: cookie, 'Content-Type': 'application/json' },
          body: '{"status":"INACTIVE"}',
        })
      ).status,
      204,
    );
  }
});

test('expired, logged-out and pending-administrator sessions cannot access any company operation', async () => {
  for (const reason of ['expired', 'logout', 'pending']) {
    const loginId = 'company' + reason;
    const id = await account(loginId);
    const cookie = await login(loginId);
    if (reason === 'expired') {
      await pool.query(
        "UPDATE admin_sessions SET created_at=now()-interval '10 hours',expires_at=now()-interval '1 hour' WHERE admin_user_seq=$1",
        [id],
      );
    } else if (reason === 'pending') {
      await pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [id]);
    } else {
      const response = await fetch(base + '/api/auth/logout', {
        method: 'POST',
        headers: { ...mutationHeaders, Cookie: cookie },
      });
      assert.equal(response.status, 204);
    }
    for (const [method, path] of [
      ['GET', ''],
      ['POST', ''],
      ['GET', '/1'],
      ['PATCH', '/1'],
    ]) {
      const response = await request(path, { method, headers: { Cookie: cookie } });
      assert.equal(response.status, 401, reason + ' ' + method + ' ' + path);
    }
  }
});

test('registration returns only an ID; detail preserves the agreed name/status contract', async () => {
  const response = await create('  등록 기업  ');
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.data), ['organizationSeq']);
  assert.ok(body.data.organizationSeq > 0);
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  const detail = await request('/' + body.data.organizationSeq);
  assert.deepEqual((await detail.json()).data, {
    organizationSeq: body.data.organizationSeq,
    name: '등록 기업',
    status: 'ACTIVE',
    memberCount: 0,
    createdAt: (
      await pool.query('SELECT created_at FROM organizations WHERE organization_seq=$1', [
        body.data.organizationSeq,
      ])
    ).rows[0].created_at.toISOString(),
    monthlyBillingEnabled: false,
  });
});

test('lists use stable pagination, status and literal name searches without exposing other tables', async () => {
  for (const name of ['검색 A', '검색 B', '검색 C', 'literal %_ company'])
    assert.equal((await create(name)).status, 201);
  const first = await (await request('?q=' + encodeURIComponent('검색') + '&limit=2')).json();
  assert.deepEqual(Object.keys(first).sort(), ['data', 'hasNext', 'total_count']);
  assert.equal(first.data.length, 2);
  assert.equal(first.hasNext, true);
  assert.equal(first.total_count, 3);
  assert.ok(first.data[0].organizationSeq > first.data[1].organizationSeq);
  const last = await (
    await request('?q=' + encodeURIComponent('검색') + '&limit=2&offset=2')
  ).json();
  assert.equal(last.data.length, 1);
  assert.equal(last.hasNext, false);
  assert.equal(last.total_count, 3);
  const pastEnd = await (await request('?q=' + encodeURIComponent('검색') + '&offset=100')).json();
  assert.deepEqual(pastEnd, { data: [], hasNext: false, total_count: 3 });
  assert.ok(!first.data.some((row) => row.organizationSeq === last.data[0].organizationSeq));
  const literal = await (await request('?q=%25_')).json();
  assert.equal(literal.data.length, 1);
  assert.equal(literal.total_count, 1);
  assert.equal(literal.data[0].name, 'literal %_ company');
  for (const row of first.data)
    assert.deepEqual(Object.keys(row).sort(), [
      'createdAt',
      'memberCount',
      'monthlyBillingEnabled',
      'name',
      'organizationSeq',
      'status',
    ]);
});

test('patch updates name/status with no response body and preserves memberships/pins', async () => {
  const id = (await (await create('상태 변경 기업')).json()).data.organizationSeq;
  const customer = await pool.query(
    `INSERT INTO customers(name,phone_number,status) VALUES ('fixture','01000000000','ACTIVE') RETURNING customer_seq`,
  );
  await testMembership(pool, {
    customerSeq: customer.rows[0].customer_seq,
    organizationSeq: id,
    employeeNo: '0001',
  });
  const address = {
    name: 'fixture',
    phoneNumber: '01000000000',
    roadAddress: '테스트 도로',
    jibunAddress: '테스트 지번',
    detailAddress: '1층',
    dongName: '테스트동',
    postalCode: '00000',
    latitude: 37,
    longitude: 127,
  };
  await pool.query(
    `INSERT INTO company_pins(organization_seq,address_data) VALUES ($1,$2::jsonb)`,
    [id, JSON.stringify(address)],
  );
  const response = await patch(id, { name: ' 수정된 기업 ', status: 'INACTIVE' });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.deepEqual((await (await request('/' + id)).json()).data, {
    organizationSeq: id,
    name: '수정된 기업',
    status: 'INACTIVE',
    memberCount: 1,
    createdAt: (
      await pool.query('SELECT created_at FROM organizations WHERE organization_seq=$1', [id])
    ).rows[0].created_at.toISOString(),
    monthlyBillingEnabled: false,
  });
  assert.equal(
    (await pool.query('SELECT count(*) FROM memberships WHERE organization_seq=$1', [id])).rows[0]
      .count,
    '1',
  );
  assert.equal(
    (await pool.query('SELECT count(*) FROM company_pins WHERE organization_seq=$1', [id])).rows[0]
      .count,
    '1',
  );
  const filtered = await (await request('?status=INACTIVE')).json();
  assert.ok(filtered.data.some((row) => row.organizationSeq === id));
  assert.equal((await patch(id, { status: 'ACTIVE' })).status, 204);
  assert.equal((await request('/' + id, { method: 'DELETE' })).status, 204);
  assert.equal((await request('/' + id)).status, 404);
});

test('invalid input, extra fields and invalid IDs never create or change records', async () => {
  for (const body of [
    { name: '' },
    { name: ' ' },
    { name: 42 },
    { name: null },
    { name: 'valid', address: 'private' },
    { name: 'valid', status: 'INACTIVE' },
  ]) {
    const response = await request('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
  }
  for (const query of [
    'limit=0',
    'limit=101',
    'offset=-1',
    'limit=1e2',
    'status=PENDING',
    'q=a&q=b',
    'unexpected=true',
  ])
    assert.equal((await request('?' + query)).status, 400, query);
  for (const id of ['0', '-1', '2147483648', '1e2', 'abc'])
    assert.equal((await request('/' + id)).status, 400, id);
  const id = (await (await create('수정 검증')).json()).data.organizationSeq;
  for (const body of [
    {},
    { name: null },
    { name: ' ' },
    { status: null },
    { status: 'PENDING' },
    { companySeq: 1 },
  ])
    assert.equal((await patch(id, body)).status, 400);
  assert.equal((await request('/2147483647')).status, 404);
  assert.equal((await patch(2147483647, { name: 'missing' })).status, 404);
});

test('registration needs no request key and repeated names or legacy headers create independent companies', async () => {
  const name = '독립 등록 ' + randomUUID();
  const first = await create(name);
  const second = await create(name, 'legacy-key');
  const third = await create(name, 'legacy-key', baseB);
  for (const response of [first, second, third]) assert.equal(response.status, 201);
  const ids = await Promise.all(
    [first, second, third].map(async (response) => (await response.json()).data.organizationSeq),
  );
  assert.equal(new Set(ids).size, 3);
  assert.equal(
    (await pool.query('SELECT count(*) FROM organizations WHERE name=$1', [name])).rows[0].count,
    '3',
  );
});

test('registered companies remain readable after application restart', async () => {
  const original = (await (await create('재시작 검증 기업')).json()).data;
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  app = await start();
  base = await app.getUrl();
  cookies.set(base, sessionA);
  const response = await request('/' + original.organizationSeq);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.name, '재시작 검증 기업');
});

test('OpenAPI describes the four company operations and their actual envelopes', async () => {
  const document = await (await fetch(base + '/api/docs-json')).json();
  for (const [path, method] of [
    ['/api/companies', 'get'],
    ['/api/companies', 'post'],
    ['/api/companies/{id}', 'get'],
    ['/api/companies/{id}', 'patch'],
  ]) {
    assert.ok(document.paths[path][method]);
    assert.deepEqual(document.paths[path][method].security, [{ adminSession: [] }]);
  }
  assert.equal(document.components.securitySchemes.adminSession.name, 'dva_session');
  assert.ok(
    document.paths['/api/companies'].get.responses['200'].content['application/json'].schema
      .properties.hasNext,
  );
  assert.ok(
    (document.paths['/api/companies'].post.parameters ?? []).every(
      (header) => header.name !== 'Idempotency-Key',
    ),
  );
  assert.ok(document.paths['/api/companies/{id}'].patch.responses['204']);
});

test('each company creation records its authenticated actor and request once', async () => {
  const key = randomUUID();
  const name = '감사 등록 ' + key;
  const first = await create(name, key);
  assert.equal(first.status, 201);
  const id = (await first.json()).data.organizationSeq;
  assert.equal((await create(name, key)).status, 201);
  const rows = (
    await pool.query(
      "SELECT * FROM audit_logs WHERE target_type='ORGANIZATION' AND target_seq=$1 AND action='ORGANIZATION_CREATED' AND result='SUCCESS'",
      [id],
    )
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_seq, adminA);
  assert.equal(rows[0].request_id, first.headers.get('x-request-id'));
  assert.deepEqual(rows[0].metadata, {});
  const rejected = await create(' ', key);
  assert.equal(rejected.status, 400);
  const failures = (
    await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
      rejected.headers.get('x-request-id'),
    ])
  ).rows;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].result, 'FAILED');
  assert.equal(failures[0].actor_seq, adminA);
});

test('company creation rolls back when success audit cannot be saved', async () => {
  const { AuditService } = require('../dist/audit/audit.service');
  const audit = app.get(AuditService);
  const original = audit.recordSuccess;
  const key = randomUUID();
  const name = '감사 롤백 ' + key;
  audit.recordSuccess = async () => {
    throw new Error('private audit storage failure');
  };
  try {
    const response = await create(name, key);
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('private audit storage failure'));
    assert.equal(
      (await pool.query('SELECT count(*) FROM organizations WHERE name=$1', [name])).rows[0].count,
      '0',
    );
    const rows = (
      await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
        response.headers.get('x-request-id'),
      ])
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].result, 'FAILED');
    assert.equal(rows[0].action, 'ORGANIZATION_CREATED');
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal((await create(name, key)).status, 201);
});

test('company update audit commits with the change and rolls back on audit failure', async () => {
  const { AuditService } = require('../dist/audit/audit.service');
  const audit = app.get(AuditService);
  const created = await create('수정 감사 원본 ' + randomUUID());
  assert.equal(created.status, 201);
  const id = (await created.json()).data.organizationSeq;
  const updated = await patch(id, { name: '수정 감사 성공', status: 'INACTIVE' });
  assert.equal(updated.status, 204);
  const rows = (
    await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
      updated.headers.get('x-request-id'),
    ])
  ).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].action, 'ORGANIZATION_UPDATED');
  assert.equal(rows[0].target_type, 'ORGANIZATION');
  assert.equal(rows[0].target_seq, id);
  assert.equal(rows[0].actor_seq, adminA);
  assert.equal(rows[0].result, 'SUCCESS');
  assert.deepEqual(rows[0].metadata, {});
  const original = audit.recordSuccess;
  audit.recordSuccess = async () => {
    throw new Error('private audit error');
  };
  try {
    const failed = await patch(id, { name: '저장되면 안 됨', status: 'ACTIVE' });
    assert.equal(failed.status, 500);
    const record = (
      await pool.query('SELECT name,status FROM organizations WHERE organization_seq=$1', [id])
    ).rows[0];
    assert.deepEqual(record, { name: '수정 감사 성공', status: 'INACTIVE' });
    const failures = (
      await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
        failed.headers.get('x-request-id'),
      ])
    ).rows;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].result, 'FAILED');
    assert.equal(failures[0].target_seq, id);
  } finally {
    audit.recordSuccess = original;
  }
  const denied = await request('/' + id, {
    method: 'PATCH',
    headers: { Cookie: undefined, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'ACTIVE' }),
  });
  assert.equal(denied.status, 401);
  const denial = (
    await pool.query('SELECT * FROM audit_logs WHERE request_id=$1', [
      denied.headers.get('x-request-id'),
    ])
  ).rows;
  assert.equal(denial.length, 1);
  assert.equal(denial[0].result, 'DENIED');
  assert.equal(denial[0].actor_seq, null);
  assert.equal(denial[0].target_seq, id);
  const missing = await patch(2147483647, { status: 'ACTIVE' });
  assert.equal(missing.status, 404);
  assert.equal(
    (
      await pool.query('SELECT result FROM audit_logs WHERE request_id=$1', [
        missing.headers.get('x-request-id'),
      ])
    ).rows[0].result,
    'FAILED',
  );
});
