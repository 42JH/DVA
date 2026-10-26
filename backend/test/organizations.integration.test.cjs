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
const { OrganizationsRepository } = require('../dist/organizations/organizations.repository');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
let app, appB, base, baseB, adminA, adminB, repository, hash, sessionA;
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
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The auth suite runs first in CI and leaves its schema/runtime account for later suites.
    // A standalone invocation against an empty disposable DB also applies the prerequisites.
    const initialized = await client.query(
      "SELECT to_regclass('public.admin_sessions') IS NOT NULL AS ready",
    );
    const migrations = initialized.rows[0].ready
      ? ['004-organization-creation-requests.sql']
      : [
          '002-monolith-initial.sql',
          '003-admin-auth-sessions.sql',
          '004-organization-creation-requests.sql',
        ];
    for (const name of migrations)
      await client.query(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
  repository = app.get(OrganizationsRepository);
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
const create = (name, key = randomUUID(), host = base, extra = {}) =>
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
  });
});

test('lists use stable pagination, status and literal name searches without exposing other tables', async () => {
  for (const name of ['검색 A', '검색 B', '검색 C', 'literal %_ company'])
    assert.equal((await create(name)).status, 201);
  const first = await (await request('?q=' + encodeURIComponent('검색') + '&limit=2')).json();
  assert.deepEqual(Object.keys(first).sort(), ['data', 'hasNext']);
  assert.equal(first.data.length, 2);
  assert.equal(first.hasNext, true);
  assert.ok(first.data[0].organizationSeq > first.data[1].organizationSeq);
  const last = await (
    await request('?q=' + encodeURIComponent('검색') + '&limit=2&offset=2')
  ).json();
  assert.equal(last.data.length, 1);
  assert.equal(last.hasNext, false);
  assert.ok(!first.data.some((row) => row.organizationSeq === last.data[0].organizationSeq));
  const literal = await (await request('?q=%25_')).json();
  assert.equal(literal.data.length, 1);
  assert.equal(literal.data[0].name, 'literal %_ company');
  for (const row of first.data)
    assert.deepEqual(Object.keys(row).sort(), ['name', 'organizationSeq', 'status']);
});

test('patch updates name/status with no response body and preserves memberships/pins', async () => {
  const id = (await (await create('상태 변경 기업')).json()).data.organizationSeq;
  const customer = await pool.query(
    `INSERT INTO customers(name,phone_number,status) VALUES ('fixture','01000000000','ACTIVE') RETURNING customer_seq`,
  );
  await pool.query(
    `INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES ($1,$2,'0001','MEMBER','ACTIVE')`,
    [customer.rows[0].customer_seq, id],
  );
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
  assert.equal((await request('/' + id, { method: 'DELETE' })).status, 404);
});

test('invalid input, extra fields, missing keys and invalid IDs never create or change records', async () => {
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
  for (const headers of [{}, { 'Idempotency-Key': 'invalid' }]) {
    const response = await request('', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: '{"name":"valid"}',
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

test('same key replays the original ID, different body conflicts, different keys may share a name', async () => {
  const key = randomUUID();
  const first = (await (await create('재시도 기업', key)).json()).data;
  const retry = await create('재시도 기업', key.toUpperCase());
  assert.equal(retry.status, 201);
  assert.deepEqual((await retry.json()).data, first);
  const conflict = await create('다른 기업', key);
  assert.equal(conflict.status, 422);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_KEY_REUSED');
  const duplicateName = (await (await create('재시도 기업')).json()).data;
  assert.notEqual(duplicateName.organizationSeq, first.organizationSeq);
});

test('completed registration survives application restart and replays the same ID', async () => {
  const key = randomUUID();
  const original = (await (await create('재시작 검증 기업', key)).json()).data;
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  app = await start();
  base = await app.getUrl();
  cookies.set(base, sessionA);
  repository = app.get(OrganizationsRepository);
  const response = await create('재시작 검증 기업', key);
  assert.equal(response.status, 201);
  assert.deepEqual((await response.json()).data, original);
});

test('the same key is scoped by the actual logged-in administrator', async () => {
  const key = randomUUID();
  const first = (await (await create('관리자 A 기업', key)).json()).data;
  const second = (await (await create('관리자 B 기업', key, baseB)).json()).data;
  assert.notEqual(first.organizationSeq, second.organizationSeq);
  const actors = await pool.query(
    'SELECT admin_user_seq FROM api_idempotency.organization_creations WHERE idempotency_key=$1 ORDER BY admin_user_seq',
    [key],
  );
  assert.deepEqual(
    actors.rows.map((row) => row.admin_user_seq),
    [adminA, adminB],
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) FROM api_idempotency.organization_creations WHERE idempotency_key=$1',
        [key],
      )
    ).rows[0].count,
    '2',
  );
});

test('concurrent retries create exactly one organization and busy requests return 409', async () => {
  const key = randomUUID();
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => create('동시 등록 기업', key)),
  );
  assert.ok(responses.every((response) => [201, 409].includes(response.status)));
  assert.equal(
    (await pool.query('SELECT count(*) FROM organizations WHERE name=$1', ['동시 등록 기업']))
      .rows[0].count,
    '1',
  );
  const locked = randomUUID(),
    client = await pool.connect();
  try {
    await client.query('BEGIN');
    assert.equal(await repository.lockCreation(client, adminA, locked), true);
    const response = await create('처리 중 기업', locked);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'REQUEST_IN_PROGRESS');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  assert.equal((await create('처리 중 기업', locked)).status, 201);
});

test('a failed idempotency write rolls back the organization, allowing a successful retry', async () => {
  const key = randomUUID();
  await pool.query(`CREATE FUNCTION fail_creation_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private storage failure'; END $$;
    CREATE TRIGGER fail_creation_receipt BEFORE INSERT ON api_idempotency.organization_creations FOR EACH ROW EXECUTE FUNCTION fail_creation_receipt()`);
  try {
    const response = await create('롤백 검증 기업', key);
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('private storage failure'));
    assert.equal(
      (await pool.query('SELECT count(*) FROM organizations WHERE name=$1', ['롤백 검증 기업']))
        .rows[0].count,
      '0',
    );
  } finally {
    await pool.query(
      'DROP TRIGGER fail_creation_receipt ON api_idempotency.organization_creations; DROP FUNCTION fail_creation_receipt()',
    );
  }
  assert.equal((await create('롤백 검증 기업', key)).status, 201);
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
    document.paths['/api/companies'].post.parameters.some(
      (header) => header.name === 'Idempotency-Key' && header.required,
    ),
  );
  assert.ok(document.paths['/api/companies/{id}'].patch.responses['204']);
});
