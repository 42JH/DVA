require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
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
const { CustomersRepository } = require('../dist/customers/customers.repository');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const apps = [];
const password = 'customer-test-only-password';
const origin = 'http://localhost:5173';
let app, base, baseB, repository, adminCookie, adminId, passwordHash;
const phone = () => '010' + String(randomInt(10000000, 100000000));
async function start() {
  const application = await NestFactory.create(AppModule, { logger: false });
  apps.push(application);
  configureApplication(application, { log: () => {} });
  await application.listen(0, '127.0.0.1');
  return application;
}
async function account(role = 'OPERATOR') {
  const loginId = 'cus' + randomUUID().replaceAll('-', '').slice(0, 16);
  const { rows } = await pool.query(
    `INSERT INTO admin_users (login_id,name,password_hash,role,status)
     VALUES ($1,'고객 테스트',$2,$3,'ACTIVE') RETURNING admin_user_seq`,
    [loginId, passwordHash, role],
  );
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
  assert.equal(response.status, 200);
  return { id: rows[0].admin_user_seq, cookie: response.headers.get('set-cookie').split(';')[0] };
}
before(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [table, migration] of [
      ['public.customers', '002-monolith-initial.sql'],
      ['public.admin_sessions', '003-admin-auth-sessions.sql'],
      ['api_idempotency.organization_creations', '004-organization-creation-requests.sql'],
      ['api_idempotency.customer_creations', '005-customer-creation-requests.sql'],
    ]) {
      const { rows } = await client.query('SELECT to_regclass($1) AS name', [table]);
      if (!rows[0].name)
        await client.query(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  passwordHash = await hashPassword(password);
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
  return fetch(host + '/api/customers' + path, options);
}
function create(
  input = { name: '고객', phoneNumber: phone() },
  key = randomUUID(),
  host = base,
  headers = {},
) {
  return request(
    '',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...headers },
      body: JSON.stringify(input),
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
async function error(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}

test('MVP AI can register, read and rename without cookie, token, call header or Origin', async () => {
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
  });
  const updated = await patch(id, { name: '  변경 고객  ' });
  assert.equal(updated.status, 204);
  assert.equal(await updated.text(), '');
  assert.equal((await (await request('/' + id)).json()).data.name, '변경 고객');
});

test('customer list and status changes require a real active administrator; forged headers grant nothing', async () => {
  const id = await register();
  for (const cookie of [undefined, 'dva_session=bad', 'dva_session=' + 'f'.repeat(64)]) {
    const headers = { Origin: origin, 'X-Admin-User-Seq': String(adminId), 'X-AI-Client': 'true' };
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

test('administrator mutations keep Origin checks and stale cookies cannot downgrade to anonymous access', async () => {
  const id = await register();
  await error(await patch(id, { status: 'WITHDRAWN' }, { Cookie: adminCookie }), 403, 'FORBIDDEN');
  await error(await patch(id, { name: '차단' }, { Cookie: adminCookie }), 403, 'FORBIDDEN');
  await error(
    await create(undefined, randomUUID(), base, { Cookie: adminCookie }),
    403,
    'FORBIDDEN',
  );
  await error(
    await patch(id, { name: '차단' }, { Origin: 'https://untrusted.invalid' }),
    403,
    'FORBIDDEN',
  );
  for (const reason of ['expired', 'pending', 'logout']) {
    const admin = await account();
    if (reason === 'expired')
      await pool.query(
        "UPDATE admin_sessions SET created_at=now()-interval '10 hours',expires_at=now()-interval '1 hour' WHERE admin_user_seq=$1",
        [admin.id],
      );
    else if (reason === 'pending')
      await pool.query("UPDATE admin_users SET status='PENDING' WHERE admin_user_seq=$1", [
        admin.id,
      ]);
    else {
      const logout = await fetch(base + '/api/auth/logout', {
        method: 'POST',
        headers: { Cookie: admin.cookie, Origin: origin },
      });
      assert.equal(logout.status, 204);
    }
    const headers = { Cookie: admin.cookie, Origin: origin };
    await error(await request('', { headers }), 401, 'UNAUTHORIZED');
    await error(await request('/' + id, { headers }), 401, 'UNAUTHORIZED');
    await error(await patch(id, { status: 'WITHDRAWN' }, headers), 401, 'UNAUTHORIZED');
    await error(await patch(id, { name: '차단' }, headers), 401, 'UNAUTHORIZED');
    await error(await create(undefined, randomUUID(), base, headers), 401, 'UNAUTHORIZED');
  }
});

test('list supports literal name search, exact phone, state and stable offset pages', async () => {
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
    assert.deepEqual(Object.keys(result).sort(), ['data', 'hasNext']);
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
  assert.deepEqual((await list({ phoneNumber: inputs[0].phoneNumber.slice(1) })).data, []);
  assert.deepEqual(
    (await list({ q: prefix, status: 'WITHDRAWN' })).data.map((row) => row.customerSeq),
    [ids[1]],
  );
  assert.deepEqual(await list({ q: prefix, offset: '1000' }), { data: [], hasNext: false });
  for (const query of [
    'limit=0',
    'limit=101',
    'offset=-1',
    'offset=1.5',
    'q=a&q=b',
    'phoneNumber=010-1234',
    'status=INACTIVE',
    'page=1',
  ])
    await error(await request('?' + query, { headers: adminHeaders() }), 400, 'INVALID_REQUEST');
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
  for (const key of ['', 'invalid'])
    await error(await create(undefined, key), 400, 'INVALID_REQUEST');
  const missingKey = await request('', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '고객', phoneNumber: phone() }),
  });
  await error(missingKey, 400, 'INVALID_REQUEST');
  await error(await request('/2147483647'), 404, 'NOT_FOUND');
  await error(await patch(2147483647, { name: '실패' }), 404, 'NOT_FOUND');
  assert.equal((await pool.query('SELECT count(*) FROM customers')).rows[0].count, before);
});

test('registration replays across callers and restart, rejects changed payload and duplicate phone', async () => {
  const input = { name: '재시도 고객', phoneNumber: phone() };
  const key = randomUUID();
  const first = await create(input, key);
  assert.equal(first.status, 201);
  const body = await first.json();
  const replay = await create(
    { ...input, name: '  재시도 고객  ' },
    key.toUpperCase(),
    baseB,
    adminHeaders(),
  );
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, body.data);
  await error(await create({ ...input, name: '다른 이름' }, key), 422, 'IDEMPOTENCY_KEY_REUSED');
  await error(await create({ ...input, phoneNumber: phone() }, key), 422, 'IDEMPOTENCY_KEY_REUSED');
  await error(await create(input), 409, 'DUPLICATE_RESOURCE');
  const restarted = await start();
  const afterRestart = await create(input, key, await restarted.getUrl());
  assert.equal(afterRestart.status, 201);
  assert.deepEqual((await afterRestart.json()).data, body.data);
  const receipts = await pool.query(
    'SELECT count(*) FROM api_idempotency.customer_creations WHERE customer_seq=$1',
    [body.data.customerSeq],
  );
  assert.equal(receipts.rows[0].count, '1');
});

test('concurrent retries and different-key phone collisions create exactly one customer', async () => {
  const input = { name: '동시 고객', phoneNumber: phone() };
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => create(input, key, i % 2 ? base : baseB)),
  );
  for (const response of results) assert.ok([201, 409].includes(response.status));
  assert.ok(results.some((response) => response.status === 201));
  assert.equal((await create(input, key)).status, 201);
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [input.phoneNumber]))
      .rows[0].count,
    '1',
  );
  const other = { name: '번호 충돌', phoneNumber: phone() };
  const collision = await Promise.all([create(other), create(other, randomUUID(), baseB)]);
  assert.deepEqual(collision.map((response) => response.status).sort(), [201, 409]);
  const failed = collision.find((response) => response.status === 409);
  assert.equal((await failed.json()).error.code, 'DUPLICATE_RESOURCE');
});

test('an in-progress key returns 409 and a DB receipt failure rolls back the customer and allows retry', async () => {
  const input = { name: '잠금 고객', phoneNumber: phone() };
  const key = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    assert.equal(await repository.lockCreation(client, key), true);
    await error(await create(input, key), 409, 'REQUEST_IN_PROGRESS');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  const failure = { name: '롤백 고객', phoneNumber: phone() };
  const failureKey = randomUUID();
  await pool.query(
    `CREATE FUNCTION api_idempotency.fail_customer_receipt_34() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt failure'; END $$`,
  );
  try {
    await pool.query(
      `CREATE TRIGGER fail_customer_receipt_34 BEFORE INSERT ON api_idempotency.customer_creations FOR EACH ROW EXECUTE FUNCTION api_idempotency.fail_customer_receipt_34()`,
    );
    await error(await create(failure, failureKey), 500, 'INTERNAL_ERROR');
    assert.equal(
      (
        await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [
          failure.phoneNumber,
        ])
      ).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM api_idempotency.customer_creations WHERE idempotency_key=$1',
          [failureKey],
        )
      ).rows[0].count,
      '0',
    );
  } finally {
    await pool.query(
      'DROP TRIGGER IF EXISTS fail_customer_receipt_34 ON api_idempotency.customer_creations',
    );
    await pool.query('DROP FUNCTION api_idempotency.fail_customer_receipt_34()');
  }
  assert.equal((await create(failure, failureKey)).status, 201);
  assert.equal((await create(input, key)).status, 201);
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
  await pool.query(
    "INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES($1,$2,'001','MEMBER','ACTIVE')",
    [id, companyId],
  );
  await pool.query('INSERT INTO orders(customer_seq) VALUES($1)', [id]);
  const address = {
    name: '수령인',
    phoneNumber: '01000000000',
    roadAddress: '테스트로 1',
    jibunAddress: '테스트동 1',
    detailAddress: '',
    dongName: '테스트동',
    postalCode: '12345',
    latitude: 37.5,
    longitude: 127.0,
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
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).data.customerSeq, id);
  await error(
    await patch(id, { name: '실패', status: 'ACTIVE' }, adminHeaders()),
    409,
    'INVALID_STATE',
  );
  const detail = await request('/' + id, { headers: adminHeaders() });
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).data, { customerSeq: id, ...input, status: 'WITHDRAWN' });
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

test('OpenAPI exposes four customer operations, minimal envelopes and conditional admin access', async () => {
  const response = await fetch(base + '/api/docs-json');
  const document = await response.json();
  const paths = document.paths;
  assert.deepEqual(paths['/api/customers'].get.security, [{ adminSession: [] }]);
  assert.deepEqual(paths['/api/customers'].post.security, []);
  assert.deepEqual(paths['/api/customers/{id}'].get.security, []);
  assert.deepEqual(paths['/api/customers/{id}'].patch.security, [{ adminSession: [] }, {}]);
  assert.equal(
    paths['/api/customers'].post.parameters.find((header) => header.name === 'Idempotency-Key')
      .required,
    true,
  );
  assert.ok(!paths['/api/customers/{id}'].patch.responses['204'].content);
  assert.deepEqual(Object.keys(document.components.schemas.UpdateCustomerDto.properties).sort(), [
    'name',
    'status',
  ]);
  assert.deepEqual(
    Object.keys(document.components.schemas.CustomersEnvelopeDto.properties).sort(),
    ['data', 'hasNext'],
  );
});
