const { testMembership } = require('./helpers/membership.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { migrate } = require('./helpers/migrations.cjs');
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
  await migrate(pool);
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
    monthlyBillingEnabled: false,
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

test('OpenAPI exposes four customer operations, minimal envelopes and conditional admin access', async () => {
  const response = await fetch(base + '/api/docs-json');
  const document = await response.json();
  const paths = document.paths;
  assert.deepEqual(paths['/api/customers'].get.security, [{ adminSession: [] }]);
  assert.deepEqual(paths['/api/customers'].post.security, []);
  assert.deepEqual(paths['/api/customers/{id}'].get.security, []);
  assert.deepEqual(paths['/api/customers/{id}'].patch.security, [{ adminSession: [] }, {}]);
  assert.equal(
    (paths['/api/customers'].post.parameters ?? []).some(
      (header) => header.name === 'Idempotency-Key',
    ),
    false,
  );
  assert.ok(!paths['/api/customers/{id}'].patch.responses['204'].content);
  assert.deepEqual(Object.keys(document.components.schemas.UpdateCustomerDto.properties).sort(), [
    'monthlyBillingEnabled',
    'name',
    'status',
  ]);
  assert.deepEqual(
    Object.keys(document.components.schemas.CustomersEnvelopeDto.properties).sort(),
    ['data', 'hasNext'],
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
