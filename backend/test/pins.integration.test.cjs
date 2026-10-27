require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { AppModule } = require('../dist/app.module');
const { AuditService } = require('../dist/audit/audit.service');
const { configureApplication } = require('../dist/configure-application');
const { hashPassword } = require('../dist/auth/password');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const origin = 'http://localhost:5173';
const password = 'pin-test-only-password';
let app, base, adminHeaders, passwordHash;
const logs = [];
const address = (overrides = {}) => ({
  name: '수령인',
  phoneNumber: '01000000001',
  roadAddress: '예시로 12',
  jibunAddress: '예시동 12',
  detailAddress: randomUUID(),
  dongName: '예시동',
  postalCode: '01234',
  latitude: 37.5,
  longitude: 127,
  ...overrides,
});
async function request(method, path, body, headers = adminHeaders) {
  return fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function success(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  return body.data;
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
async function admin(role = 'OPERATOR') {
  const loginId = 'pin' + randomUUID().replaceAll('-', '').slice(0, 17);
  await pool.query(
    `INSERT INTO admin_users(login_id,name,password_hash,role,status)
    VALUES($1,'주소록 관리자',$2,$3,'ACTIVE')`,
    [loginId, passwordHash, role],
  );
  const response = await request('POST', '/auth/login', { loginId, password }, { Origin: origin });
  assert.equal(response.status, 200);
  return { Origin: origin, Cookie: response.headers.get('set-cookie').split(';')[0] };
}
before(async () => {
  // check:docker의 선행 DB/주문 테스트가 배포 마이그레이션을 적용한다.
  assert.equal(
    (
      await pool.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_name='call_sessions' AND column_name='caller_phone_number') AS ready`)
    ).rows[0].ready,
    true,
  );
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: (entry) => logs.push(entry) });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  passwordHash = await hashPassword(password);
  adminHeaders = await admin();
});
after(async () => {
  if (app) await app.close();
  await pool.end();
});
async function fixture({
  customerStatus = 'ACTIVE',
  memberStatus = 'ACTIVE',
  companyStatus = 'ACTIVE',
  role = 'MEMBER',
  ended = false,
} = {}) {
  const phone = '010' + String(randomInt(10000000, 100000000));
  const customer = (
    await pool.query(
      `INSERT INTO customers(name,phone_number,status)
    VALUES('주소록 고객',$1,$2) RETURNING customer_seq`,
      [phone, customerStatus],
    )
  ).rows[0].customer_seq;
  const company = (
    await pool.query(
      `INSERT INTO organizations(name,status)
    VALUES('주소록 기업',$1) RETURNING organization_seq`,
      [companyStatus],
    )
  ).rows[0].organization_seq;
  await pool.query(
    `INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status)
    VALUES($1,$2,$3,$4,$5)`,
    [customer, company, randomUUID(), role, memberStatus],
  );
  const call = (
    await pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,started_at,ended_at)
    VALUES($1,$2,$3,$4) RETURNING call_session_seq`,
      [
        randomUUID(),
        phone,
        ended ? '2026-10-27T00:00:00Z' : null,
        ended ? '2026-10-27T00:01:00Z' : null,
      ],
    )
  ).rows[0].call_session_seq;
  return { customer, company, call, phone, ai: { call_session_seq: String(call) } };
}
async function personal(f, data = address(), extra = {}, headers = adminHeaders) {
  return success(
    await request(
      'POST',
      `/customers/${f.customer}/pins`,
      { addressData: data, ...extra },
      headers,
    ),
    201,
  );
}
async function company(f, data = address(), extra = {}) {
  return success(
    await request('POST', `/companies/${f.company}/pins`, { addressData: data, ...extra }),
    201,
  );
}
async function stored(id, shared = false) {
  return (
    await pool.query(
      shared
        ? 'SELECT * FROM company_pins WHERE company_pin_seq=$1'
        : 'SELECT * FROM personal_pins WHERE personal_pin_seq=$1',
      [id],
    )
  ).rows[0];
}

test('AI registers, searches and edits its active customer personal pins without service authentication', async () => {
  const f = await fixture();
  const input = address({ detailAddress: '101호' });
  const created = await personal(f, input, { label: '  집  ' }, f.ai);
  assert.equal(created.version, 1);
  assert.deepEqual(Object.keys(created).sort(), ['personalPinSeq', 'version']);
  const list = await request(
    'GET',
    `/customers/${f.customer}/pins?q=${encodeURIComponent('집')}`,
    undefined,
    f.ai,
  );
  assert.equal(list.status, 200);
  const body = await list.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
  assert.equal(body.hasNext, false);
  assert.deepEqual(body.data[0], {
    ...created,
    customerSeq: f.customer,
    label: '집',
    addressData: input,
  });
  const changed = await success(
    await request(
      'PATCH',
      `/pins/${created.personalPinSeq}`,
      {
        addressData: { ...input, detailAddress: '103호' },
      },
      f.ai,
    ),
  );
  assert.equal(changed.version, 2);
  assert.equal((await stored(created.personalPinSeq)).label, '집');
  assert.equal((await stored(created.personalPinSeq)).address_data.detailAddress, '103호');
});

test('all active administrator roles can manage personal and company pins', async () => {
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const headers = await admin(role);
    const f = await fixture();
    const p = await personal(f, address(), {}, headers);
    const c = await success(
      await request('POST', `/companies/${f.company}/pins`, { addressData: address() }, headers),
      201,
    );
    assert.equal(
      (await request('GET', `/companies/${f.company}/pins`, undefined, headers)).status,
      200,
    );
    assert.equal(
      (await request('PATCH', `/pins/${p.personalPinSeq}`, { label: role }, headers)).status,
      200,
    );
    assert.equal(
      (await request('PATCH', `/company-pins/${c.companyPinSeq}`, { label: role }, headers)).status,
      200,
    );
  }
});

test('AI company reads require an active customer, membership and company, including representatives', async () => {
  for (const role of ['MEMBER', 'ORG_ADMIN']) {
    const f = await fixture({ role });
    const pin = await company(f, address(), { departmentName: '개발부' });
    const list = await request('GET', `/companies/${f.company}/pins`, undefined, f.ai);
    assert.equal(list.status, 200);
    assert.equal((await list.json()).data[0].companyPinSeq, pin.companyPinSeq);
    for (const [table, key, id] of [
      ['memberships', 'customer_seq', f.customer],
      ['organizations', 'organization_seq', f.company],
      ['customers', 'customer_seq', f.customer],
    ]) {
      const state = table === 'customers' ? 'WITHDRAWN' : 'INACTIVE';
      await pool.query(`UPDATE ${table} SET status=$1 WHERE ${key}=$2`, [state, id]);
      await error(
        await request('GET', `/companies/${f.company}/pins`, undefined, f.ai),
        403,
        'FORBIDDEN',
      );
      await pool.query(`UPDATE ${table} SET status='ACTIVE' WHERE ${key}=$1`, [id]);
    }
  }
});

test('AI cannot create or modify company pins, even with representative status or forged admin headers', async () => {
  const f = await fixture({ role: 'ORG_ADMIN' });
  const pin = await company(f);
  const headers = {
    ...f.ai,
    Origin: origin,
    'X-Admin-User-Seq': '1',
    Authorization: 'Bearer fake',
  };
  await error(
    await request('POST', `/companies/${f.company}/pins`, { addressData: address() }, headers),
    401,
    'UNAUTHORIZED',
  );
  await error(
    await request('PATCH', `/company-pins/${pin.companyPinSeq}`, { label: '금지' }, headers),
    401,
    'UNAUTHORIZED',
  );
  assert.equal((await stored(pin.companyPinSeq, true)).label, null);
});

test('another caller cannot list, create or edit private pins or read another company', async () => {
  const owner = await fixture();
  const other = await fixture();
  const p = await personal(owner);
  for (const [method, path, body] of [
    ['GET', `/customers/${owner.customer}/pins`],
    ['POST', `/customers/${owner.customer}/pins`, { addressData: address() }],
    ['PATCH', `/pins/${p.personalPinSeq}`, { label: '침범' }],
    ['GET', `/companies/${owner.company}/pins`],
  ])
    await error(await request(method, path, body, other.ai), 403, 'FORBIDDEN');
  assert.equal((await stored(p.personalPinSeq)).label, null);
  await pool.query('UPDATE memberships SET organization_seq=$1 WHERE customer_seq=$2', [
    owner.company,
    other.customer,
  ]);
  await error(
    await request('GET', `/customers/${owner.customer}/pins`, undefined, other.ai),
    403,
    'FORBIDDEN',
  );
});

test('missing, invalid, unknown and ended call IDs are not accepted for AI operations', async () => {
  const f = await fixture();
  const p = await personal(f);
  for (const header of [undefined, '0', '-1', '1.5', 'abc', '2147483648']) {
    const headers = header === undefined ? {} : { call_session_seq: header };
    await error(
      await request('GET', `/customers/${f.customer}/pins`, undefined, headers),
      400,
      'INVALID_REQUEST',
    );
  }
  await error(
    await request('GET', `/customers/${f.customer}/pins`, undefined, {
      call_session_seq: '2147483647',
    }),
    404,
    'NOT_FOUND',
  );
  await pool.query(
    "UPDATE call_sessions SET started_at='2026-10-27T00:00:00Z',ended_at='2026-10-27T00:01:00Z' WHERE call_session_seq=$1",
    [f.call],
  );
  for (const [method, path, body] of [
    ['GET', `/customers/${f.customer}/pins`],
    ['GET', `/companies/${f.company}/pins`],
    ['POST', `/customers/${f.customer}/pins`, { addressData: address() }],
    ['PATCH', `/pins/${p.personalPinSeq}`, { label: '끝난 통화' }],
  ])
    await error(await request(method, path, body, f.ai), 409, 'INVALID_STATE');
});

test('stale administrator cookies cannot fall back to AI access; administrator writes retain Origin checks', async () => {
  const f = await fixture();
  const bad = { ...f.ai, Cookie: 'dva_session=' + 'f'.repeat(64), Origin: origin };
  await error(
    await request('GET', `/customers/${f.customer}/pins`, undefined, bad),
    401,
    'UNAUTHORIZED',
  );
  await error(
    await request('POST', `/customers/${f.customer}/pins`, { addressData: address() }, bad),
    401,
    'UNAUTHORIZED',
  );
  await error(
    await request(
      'POST',
      `/companies/${f.company}/pins`,
      { addressData: address() },
      { Cookie: adminHeaders.Cookie },
    ),
    403,
    'FORBIDDEN',
  );
  await error(
    await request('GET', `/customers/${f.customer}/pins`, undefined, {
      ...f.ai,
      Origin: 'https://untrusted.invalid',
    }),
    403,
    'FORBIDDEN',
  );
});

test('withdrawal blocks personal access; inactive company permits admin reads but no writes', async () => {
  const f = await fixture();
  const p = await personal(f);
  const c = await company(f);
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [f.customer]);
  await error(
    await request('PATCH', `/pins/${p.personalPinSeq}`, { label: '금지' }, f.ai),
    403,
    'FORBIDDEN',
  );
  await error(
    await request('POST', `/customers/${f.customer}/pins`, { addressData: address() }),
    409,
    'INVALID_STATE',
  );
  await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [
    f.company,
  ]);
  assert.equal((await request('GET', `/companies/${f.company}/pins`)).status, 200);
  await error(
    await request('POST', `/companies/${f.company}/pins`, { addressData: address() }),
    409,
    'INVALID_STATE',
  );
  await error(
    await request('PATCH', `/company-pins/${c.companyPinSeq}`, { label: '금지' }),
    409,
    'INVALID_STATE',
  );
});

test('literal search, pagination, generated search updates and company department search stay scoped', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++)
    await personal(f, address({ name: '검색 수령인' }), { label: i === 0 ? '100%_특별' : '검색' });
  let response = await request('GET', `/customers/${f.customer}/pins?limit=2`, undefined, f.ai);
  let body = await response.json();
  assert.equal(body.data.length, 2);
  assert.equal(body.hasNext, true);
  assert.ok(body.data[0].personalPinSeq < body.data[1].personalPinSeq);
  response = await request(
    'GET',
    `/customers/${f.customer}/pins?limit=2&offset=2`,
    undefined,
    f.ai,
  );
  body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.hasNext, false);
  response = await request('GET', `/customers/${f.customer}/pins?q=%25_`, undefined, f.ai);
  body = await response.json();
  assert.equal(body.data.length, 1);
  const id = body.data[0].personalPinSeq;
  await success(await request('PATCH', `/pins/${id}`, { label: '새검색어' }));
  assert.equal(
    (await (await request('GET', `/customers/${f.customer}/pins?q=%25_`, undefined, f.ai)).json())
      .data.length,
    0,
  );
  assert.equal(
    (
      await (
        await request(
          'GET',
          `/customers/${f.customer}/pins?q=${encodeURIComponent('새검색어')}`,
          undefined,
          f.ai,
        )
      ).json()
    ).data.length,
    1,
  );
  await company(f, address(), { departmentName: '개발팀' });
  assert.equal(
    (
      await (
        await request(
          'GET',
          `/companies/${f.company}/pins?q=${encodeURIComponent('개발팀')}`,
          undefined,
          f.ai,
        )
      ).json()
    ).data.length,
    1,
  );
  assert.equal(
    (await (await request('GET', `/companies/${f.company}/pins?q=absent`, undefined, f.ai)).json())
      .hasNext,
    false,
  );
});

test('Swagger exposes six operations and no required version/key or delete operation', async () => {
  const document = await (await fetch(base + '/api/docs-json')).json();
  for (const [path, methods] of [
    ['/api/customers/{id}/pins', ['get', 'post']],
    ['/api/pins/{id}', ['patch']],
    ['/api/companies/{id}/pins', ['get', 'post']],
    ['/api/company-pins/{id}', ['patch']],
  ]) {
    for (const method of methods) {
      const operation = document.paths[path][method];
      assert.deepEqual(operation.tags, ['Pins']);
      assert.ok(!(operation.parameters ?? []).some((p) => p.name === 'Idempotency-Key'));
    }
    assert.equal(document.paths[path].delete, undefined);
  }
  assert.deepEqual(document.paths['/api/companies/{id}/pins'].post.security, [
    { adminSession: [] },
  ]);
  assert.deepEqual(document.paths['/api/company-pins/{id}'].patch.security, [{ adminSession: [] }]);
  assert.deepEqual(document.paths['/api/pins/{id}'].patch.security, [{ adminSession: [] }, {}]);
  const schema = document.components.schemas.UpdatePinDto;
  assert.ok(!(schema.required ?? []).includes('expectedVersion'));
  assert.equal(schema.properties.expectedVersion.deprecated, true);
  const f = await fixture();
  const p = await personal(f);
  assert.equal((await request('DELETE', `/pins/${p.personalPinSeq}`)).status, 404);
});

test('request logging does not record phone numbers, address bodies or search terms', async () => {
  const f = await fixture();
  const requestId = randomUUID();
  const term = '개인정보검색어';
  await request('GET', `/customers/${f.customer}/pins?q=${encodeURIComponent(term)}`, undefined, {
    ...f.ai,
    'X-Request-Id': requestId,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const entries = logs.filter((entry) => entry.requestId === requestId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].route, '/api/customers/:id/pins');
  assert.ok(!JSON.stringify(entries).includes(f.phone));
  assert.ok(!JSON.stringify(entries).includes(term));
});
