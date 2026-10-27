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
const origin = 'http://localhost:5173',
  password = 'directory-test-only-password';
let app, base, adminHeaders, passwordHash;
const logs = [];
const marker = () => 'dir' + randomUUID().replaceAll('-', '');
const address = (extra = {}) => ({
  name: '공식 배송 담당자',
  phoneNumber: '01000001234',
  roadAddress: '공식로 12',
  jibunAddress: '공식동 12',
  detailAddress: randomUUID(),
  dongName: '공식동',
  postalCode: '01234',
  latitude: 37.5,
  longitude: 127,
  ...extra,
});
const search = (query, headers = {}) =>
  fetch(
    base +
      '/api/companies/search?' +
      (typeof query === 'string' ? query : new URLSearchParams(query).toString()),
    { headers },
  );
async function result(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.ok(response.headers.get('x-request-id'));
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext']);
  return body;
}
async function error(response, status, code) {
  assert.equal(response.status, status, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
}
async function account(role = 'OPERATOR') {
  const loginId = 'dir' + randomUUID().replaceAll('-', '').slice(0, 17);
  await pool.query(
    `INSERT INTO admin_users(login_id,name,password_hash,role,status)
    VALUES($1,'디렉터리 관리자',$2,$3,'ACTIVE')`,
    [loginId, passwordHash, role],
  );
  const response = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return {
    Cookie: response.headers.get('set-cookie').split(';')[0],
    Origin: origin,
    'Content-Type': 'application/json',
  };
}
before(async () => {
  // check:docker의 선행 검증이 기존 업무 스키마를 적용한다.
  assert.ok((await pool.query("SELECT to_regclass('public.company_pins') AS name")).rows[0].name);
  app = await NestFactory.create(AppModule, { logger: false });
  configureApplication(app, { log: (entry) => logs.push(entry) });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  passwordHash = await hashPassword(password);
  adminHeaders = await account();
});
after(async () => {
  if (app) await app.close();
  await pool.end();
});
async function company(name = marker(), status = 'ACTIVE') {
  const id = (
    await pool.query(
      'INSERT INTO organizations(name,status) VALUES($1,$2) RETURNING organization_seq',
      [name, status],
    )
  ).rows[0].organization_seq;
  return { id, name };
}
async function pin(c, { label = null, departmentName = null, addressData = address() } = {}) {
  const row = (
    await pool.query(
      `INSERT INTO company_pins(organization_seq,label,department_name,address_data)
    VALUES($1,$2,$3,$4) RETURNING company_pin_seq AS "companyPinSeq",version`,
      [c.id, label, departmentName, addressData],
    )
  ).rows[0];
  return {
    ...row,
    organizationSeq: c.id,
    organizationName: c.name,
    label,
    departmentName,
    addressData,
  };
}

test('search returns active company official PINs without customer, membership or call prerequisites', async () => {
  const c = await company();
  const p = await pin(c, { label: '물류센터', departmentName: '배송부' });
  assert.deepEqual(await result(await search({ q: c.name })), { data: [p], hasNext: false });
  // 공개 디렉터리는 특정 통화나 소속에 결속하지 않는다.
  assert.deepEqual(await result(await search({ q: c.name }, { call_session_seq: '2147483647' })), {
    data: [p],
    hasNext: false,
  });
});

test('one company can expose several official destinations and PIN contact fields are retained', async () => {
  const c = await company();
  const first = await pin(c, { label: '본사', departmentName: '인사부' });
  const second = await pin(c, {
    label: '물류센터',
    departmentName: '운영부',
    addressData: address({ name: '물류 수령인', phoneNumber: '07012345678' }),
  });
  const body = await result(await search({ q: c.name }));
  assert.deepEqual(body.data, [first, second]);
  assert.equal(body.data[1].addressData.name, '물류 수령인');
  assert.equal(body.data[1].addressData.phoneNumber, '07012345678');
  assert.equal(body.data[0].addressData.postalCode, '01234');
});

test('inactive companies and companies without official PINs do not appear', async () => {
  const token = marker();
  const inactive = await company(token + ' 비활성', 'INACTIVE');
  await pin(inactive);
  await company(token + ' 빈기업');
  assert.deepEqual(await result(await search({ q: token })), { data: [], hasNext: false });
});

test('homonymous companies remain separate and pagination has deterministic company/PIN ordering', async () => {
  const name = marker(),
    first = await company(name),
    second = await company(name);
  const pins = [await pin(first), await pin(first), await pin(second)];
  const pages = [];
  for (let offset = 0; offset < 3; offset++) {
    const body = await result(await search({ q: name, limit: '1', offset: String(offset) }));
    assert.equal(body.hasNext, offset < 2);
    pages.push(...body.data);
  }
  assert.deepEqual(pages, pins);
  assert.deepEqual(await result(await search({ q: name, offset: '3' })), {
    data: [],
    hasNext: false,
  });
});

test('query matches company, department, label, official recipient/contact and address fields', async () => {
  const c = await company();
  const p = await pin(c, {
    label: '본사',
    departmentName: '물류센터',
    addressData: address({ name: 'Kim 가나', detailAddress: '100%_101호' }),
  });
  for (const q of [
    `${c.name} 물류센터`,
    `물류센터 ${c.name}`,
    `${c.name} kim`,
    '가나'.normalize('NFD'),
    '01000001234',
    '공식로',
    '100%_',
    '01234',
  ]) {
    const body = await result(await search({ q }));
    assert.ok(
      body.data.some((row) => row.companyPinSeq === p.companyPinSeq),
      q,
    );
  }
  assert.deepEqual(await result(await search({ q: `${c.name} 없는부서` })), {
    data: [],
    hasNext: false,
  });
  assert.deepEqual(await result(await search({ q: "' OR TRUE --" })), { data: [], hasNext: false });
  assert.deepEqual(await result(await search({ q: `  ${c.name}\t\n 물류센터  ` })), {
    data: [p],
    hasNext: false,
  });
});

test('only explicit public PIN fields are projected; member and private PIN values cannot match queries', async () => {
  const c = await company(),
    secret = marker();
  const p = await pin(c);
  const phone = '010' + String(randomInt(10000000, 100000000));
  const customer = (
    await pool.query(
      `INSERT INTO customers(name,phone_number,status)
    VALUES($1,$2,'ACTIVE') RETURNING customer_seq`,
      [secret, phone],
    )
  ).rows[0].customer_seq;
  await pool.query(
    `INSERT INTO memberships(customer_seq,organization_seq,employee_no,status)
    VALUES($1,$2,$3,'ACTIVE')`,
    [customer, c.id, secret],
  );
  await pool.query('INSERT INTO personal_pins(customer_seq,label,address_data) VALUES($1,$2,$3)', [
    customer,
    secret,
    address({ name: secret, phoneNumber: phone }),
  ]);
  const body = await result(await search({ q: c.name }));
  assert.deepEqual(body.data, [p]);
  assert.deepEqual(Object.keys(body.data[0]).sort(), [
    'addressData',
    'companyPinSeq',
    'departmentName',
    'label',
    'organizationName',
    'organizationSeq',
    'version',
  ]);
  assert.ok(!JSON.stringify(body).includes(secret));
  assert.ok(!JSON.stringify(body).includes(phone));
  assert.deepEqual(await result(await search({ q: secret })), { data: [], hasNext: false });
  assert.deepEqual(await result(await search({ q: phone })), { data: [], hasNext: false });
});

test('company and PIN edits and deactivation are reflected by the next query', async () => {
  const c = await company();
  const p = await pin(c, { label: '이전 별칭', departmentName: '이전 부서' });
  const mutate = (path, body) =>
    fetch(base + '/api' + path, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify(body),
    });
  const renamed = marker();
  assert.equal((await mutate(`/companies/${c.id}`, { name: renamed })).status, 204);
  assert.deepEqual(await result(await search({ q: c.name })), { data: [], hasNext: false });
  assert.equal((await result(await search({ q: renamed }))).data[0].organizationName, renamed);
  assert.equal(
    (
      await mutate(`/company-pins/${p.companyPinSeq}`, {
        label: '새 별칭',
        departmentName: '새 부서',
        addressData: address({ roadAddress: '새공식로 99' }),
      })
    ).status,
    200,
  );
  assert.deepEqual(await result(await search({ q: `${renamed} 이전` })), {
    data: [],
    hasNext: false,
  });
  const updated = (await result(await search({ q: `${renamed} 새공식로` }))).data[0];
  assert.equal(updated.departmentName, '새 부서');
  assert.equal(updated.version, 2);
  assert.equal((await mutate(`/companies/${c.id}`, { status: 'INACTIVE' })).status, 204);
  assert.deepEqual(await result(await search({ q: renamed })), { data: [], hasNext: false });
  assert.equal((await mutate(`/companies/${c.id}`, { status: 'ACTIVE' })).status, 204);
  assert.equal((await result(await search({ q: renamed }))).data[0].companyPinSeq, p.companyPinSeq);
});

test('every active admin role can search while the anonymous MVP read uses the same projection', async () => {
  const c = await company();
  await pin(c);
  const anonymous = await result(await search({ q: c.name }));
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN'])
    assert.deepEqual(await result(await search({ q: c.name }, await account(role))), anonymous);
});

test('stale cookies never fall back to anonymous access and untrusted Origin is rejected', async () => {
  const c = await company();
  for (const Cookie of ['dva_session=bad', 'dva_session=' + 'f'.repeat(64)])
    await error(await search({ q: c.name }, { Cookie }), 401, 'UNAUTHORIZED');
  const loggedOut = await account();
  assert.equal(
    (await fetch(base + '/api/auth/logout', { method: 'POST', headers: loggedOut })).status,
    204,
  );
  await error(await search({ q: c.name }, loggedOut), 401, 'UNAUTHORIZED');
  await error(
    await search({ q: c.name }, { Origin: 'https://untrusted.invalid' }),
    403,
    'FORBIDDEN',
  );
});

test('the search exception does not open company management, member lists or scoped PIN APIs', async () => {
  const c = await company();
  const p = await pin(c);
  assert.equal((await fetch(base + '/api/companies')).status, 401);
  assert.equal((await fetch(base + `/api/companies/${c.id}`)).status, 401);
  assert.equal((await fetch(base + `/api/companies/${c.id}/members`)).status, 401);
  await error(await fetch(base + `/api/companies/${c.id}/pins`), 400, 'INVALID_REQUEST');
  const create = await fetch(base + `/api/companies/${c.id}/pins`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ addressData: address() }),
  });
  await error(create, 401, 'UNAUTHORIZED');
  await error(
    await fetch(base + `/api/company-pins/${p.companyPinSeq}`, {
      method: 'PATCH',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: '{"label":"금지"}',
    }),
    401,
    'UNAUTHORIZED',
  );
});

test('query and pagination validation reject missing, blank, repeated and unsupported filters', async () => {
  for (const query of [
    '',
    'q=',
    'q=%20%20',
    'q=a&q=b',
    'q=a&limit=0',
    'q=a&limit=101',
    'q=a&offset=-1',
    'q=a&limit=1.5',
    'q=a&status=INACTIVE',
    'q=a&customerSeq=1',
    'q=a&organizationSeq=1',
  ])
    await error(await search(query), 400, 'INVALID_REQUEST');
  assert.deepEqual(await result(await search({ q: marker() })), { data: [], hasNext: false });
});

test('search is read-only and database failures are not transformed into empty successes', async () => {
  const c = await company();
  await pin(c);
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM organizations) AS companies,
    (SELECT count(*) FROM company_pins) AS pins,(SELECT count(*) FROM audit_logs) AS audits`)
    ).rows[0];
  const before = await counts();
  await result(await search({ q: c.name }));
  await result(await search({ q: c.name }));
  assert.deepEqual(await counts(), before);
  const repository = app.get(OrganizationsRepository),
    original = repository.searchDirectory;
  repository.searchDirectory = async () => {
    throw new Error('private directory SQL');
  };
  try {
    await error(await search({ q: c.name }), 500, 'INTERNAL_ERROR');
  } finally {
    repository.searchDirectory = original;
  }
  assert.equal((await result(await search({ q: c.name }))).data.length, 1);
});

test('Swagger exposes public PIN projection and static search remains separate from company IDs', async () => {
  const doc = await (await fetch(base + '/api/docs-json')).json();
  const operation = doc.paths['/api/companies/search'].get;
  assert.deepEqual(operation.tags, ['Companies']);
  assert.ok(operation.security.some((entry) => Object.keys(entry).length === 0));
  assert.ok(operation.parameters.some((p) => p.name === 'q' && p.required));
  assert.ok(!operation.parameters.some((p) => p.name === 'call_session_seq'));
  assert.deepEqual(
    Object.keys(doc.components.schemas.CompanyDirectoryEnvelopeDto.properties).sort(),
    ['data', 'hasNext'],
  );
  assert.ok(doc.components.schemas.CompanyDirectoryEntryDto.properties.organizationName);
  assert.ok(doc.components.schemas.CompanyDirectoryEntryDto.properties.addressData);
  assert.equal(
    (await fetch(base + '/api/companies/2147483647', { headers: adminHeaders })).status,
    404,
  );
});

test('request logs contain route templates without query, recipient or phone values', async () => {
  const requestId = randomUUID(),
    term = marker();
  await result(await search({ q: term }, { 'X-Request-Id': requestId }));
  await new Promise((resolve) => setImmediate(resolve));
  const entries = logs.filter((entry) => entry.requestId === requestId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].route, '/api/companies/search');
  assert.ok(!JSON.stringify(entries).includes(term));
});
