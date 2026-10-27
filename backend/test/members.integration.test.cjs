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
const { configureApplication } = require('../dist/configure-application');
const { MembersRepository } = require('../dist/members/members.repository');
const { hashPassword } = require('../dist/auth/password');
const { CSV_MAX_BYTES } = require('../dist/members/member-csv');
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
const apps = [];
const password = 'member-test-only-password';
const origin = 'http://localhost:5173';
const header = 'employeeNo,name,phoneNumber\n';
const phone = () => '010' + String(randomInt(10000000, 100000000));
let app, base, baseB, cookie, adminId, repository, passwordHash;
async function start() {
  const instance = await NestFactory.create(AppModule, { logger: false });
  apps.push(instance);
  configureApplication(instance, { log: () => {} });
  await instance.listen(0, '127.0.0.1');
  return instance;
}
async function account(role = 'OPERATOR') {
  const loginId = 'mem' + randomUUID().replaceAll('-', '').slice(0, 16);
  const { rows } = await pool.query(
    "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'구성원 테스트',$2,$3,'ACTIVE') RETURNING admin_user_seq",
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
      ['api_idempotency.membership_writes', '006-membership-write-requests.sql'],
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
  cookie = admin.cookie;
  adminId = admin.id;
  repository = app.get(MembersRepository);
});
after(async () => {
  for (const instance of apps) await instance.close();
  await pool.end();
});

function request(path, options = {}, host = base, session = cookie) {
  const headers = { Origin: origin, ...options.headers };
  if (session !== null) headers.Cookie = session;
  return fetch(host + '/api' + path, { ...options, headers });
}
function create(
  companyId,
  customerSeq,
  employeeNo = '001',
  key = randomUUID(),
  role = 'MEMBER',
  host = base,
  session = cookie,
) {
  return request(
    `/companies/${companyId}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ customerSeq, employeeNo, role }),
    },
    host,
    session,
  );
}
function upload(
  companyId,
  content,
  key = randomUUID(),
  host = base,
  session = cookie,
  filename = 'employees.csv',
  type = 'text/csv',
) {
  const form = new FormData();
  form.append('file', new Blob([content], { type }), filename);
  return request(
    `/companies/${companyId}/members/import`,
    { method: 'POST', headers: { 'Idempotency-Key': key }, body: form },
    host,
    session,
  );
}
function patch(id, input, session = cookie) {
  return request(
    '/members/' + id,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    },
    base,
    session,
  );
}
function remove(id, session = cookie) {
  return request('/members/' + id, { method: 'DELETE' }, base, session);
}
async function company(status = 'ACTIVE') {
  return (
    await pool.query(
      'INSERT INTO organizations(name,status) VALUES($1,$2) RETURNING organization_seq',
      ['구성원 기업 ' + randomUUID(), status],
    )
  ).rows[0].organization_seq;
}
async function customer(status = 'ACTIVE', number = phone(), name = '기존 고객') {
  const result = await pool.query(
    'INSERT INTO customers(name,phone_number,status) VALUES($1,$2,$3) RETURNING customer_seq',
    [name, number, status],
  );
  return { id: result.rows[0].customer_seq, phoneNumber: number, name };
}
async function members(id, query = '') {
  const response = await request(`/companies/${id}/members` + query);
  assert.equal(response.status, 200);
  return response.json();
}
async function member(companyId, customerId) {
  return (await members(companyId)).data.find((row) => row.customer.customerSeq === customerId)
    .membership;
}
async function empty(response) {
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
}
async function error(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  assert.ok(body.meta.requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return body;
}

test('all five member operations require real sessions and writes preserve Origin protection', async () => {
  for (const session of [null, 'dva_session=invalid', 'dva_session=' + 'f'.repeat(64)]) {
    for (const [method, path] of [
      ['GET', '/companies/1/members'],
      ['POST', '/companies/1/members'],
      ['POST', '/companies/1/members/import'],
      ['PATCH', '/members/1'],
      ['DELETE', '/members/1'],
    ])
      await error(
        await request(
          path,
          { method, headers: { 'X-Admin-User-Seq': String(adminId), 'X-AI-Client': 'true' } },
          base,
          session,
        ),
        401,
        'UNAUTHORIZED',
      );
  }
  for (const [method, path] of [
    ['POST', '/companies/1/members'],
    ['POST', '/companies/1/members/import'],
    ['PATCH', '/members/1'],
    ['DELETE', '/members/1'],
  ]) {
    const response = await fetch(base + '/api' + path, { method, headers: { Cookie: cookie } });
    await error(response, 403, 'FORBIDDEN');
  }
});

test('every active admin role can manage members and representative labels create no admin account', async () => {
  const before = (await pool.query('SELECT count(*) FROM admin_users')).rows[0].count;
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const admin = await account(role);
    const co = await company();
    const cu = await customer();
    await empty(await create(co, cu.id, '001', randomUUID(), 'ORG_ADMIN', base, admin.cookie));
    const list = await request(`/companies/${co}/members`, {}, base, admin.cookie);
    assert.equal(list.status, 200);
    const row = (await list.json()).data[0];
    assert.equal(row.membership.role, 'ORG_ADMIN');
    assert.equal(row.customer.customerSeq, cu.id);
    await empty(
      await patch(
        row.membership.membershipSeq,
        { role: 'MEMBER', status: 'INACTIVE' },
        admin.cookie,
      ),
    );
    await empty(
      await upload(co, header + `002,새 고객,${phone()}`, randomUUID(), base, admin.cookie),
    );
    await empty(await remove(row.membership.membershipSeq, admin.cookie));
  }
  assert.equal(
    Number((await pool.query('SELECT count(*) FROM admin_users')).rows[0].count),
    Number(before) + 3,
  );
});

test('expired, pending and logged-out sessions cannot upload or modify memberships', async () => {
  const co = await company();
  const cu = await customer();
  await empty(await create(co, cu.id));
  const m = await member(co, cu.id);
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
    else
      assert.equal(
        (await request('/auth/logout', { method: 'POST' }, base, admin.cookie)).status,
        204,
      );
    await error(
      await upload(co, header + `002,실패,${phone()}`, randomUUID(), base, admin.cookie),
      401,
      'UNAUTHORIZED',
    );
    await error(
      await patch(m.membershipSeq, { role: 'ORG_ADMIN' }, admin.cookie),
      401,
      'UNAUTHORIZED',
    );
    await error(await remove(m.membershipSeq, admin.cookie), 401, 'UNAUTHORIZED');
    await error(
      await request(`/companies/${co}/members`, {}, base, admin.cookie),
      401,
      'UNAUTHORIZED',
    );
  }
});

test('lists return nested member/customer views, status filters, stable pages and empty companies', async () => {
  const co = await company();
  assert.deepEqual(await members(co), { data: [], hasNext: false });
  const ids = [];
  for (const employee of ['001', '002', '003']) {
    const cu = await customer();
    await empty(await create(co, cu.id, employee));
    ids.push((await member(co, cu.id)).membershipSeq);
  }
  await empty(await patch(ids[1], { status: 'INACTIVE' }));
  const first = await members(co, '?limit=2&offset=0');
  assert.deepEqual(Object.keys(first).sort(), ['data', 'hasNext']);
  assert.deepEqual(
    first.data.map((row) => row.membership.membershipSeq),
    ids.toReversed().slice(0, 2),
  );
  assert.equal(first.hasNext, true);
  const second = await members(co, '?limit=2&offset=2');
  assert.equal(second.hasNext, false);
  assert.equal(second.data[0].membership.membershipSeq, ids[0]);
  assert.equal((await members(co, '?status=INACTIVE')).data[0].membership.membershipSeq, ids[1]);
  assert.deepEqual(await members(co, '?offset=1000'), { data: [], hasNext: false });
  for (const query of [
    'status=PENDING',
    'limit=0',
    'limit=101',
    'offset=-1',
    'offset=1.1',
    'page=1',
    'status=ACTIVE&status=INACTIVE',
  ])
    await error(await request(`/companies/${co}/members?${query}`), 400, 'INVALID_REQUEST');
  await error(await request('/companies/2147483647/members'), 404, 'NOT_FOUND');
});

test('manual registration validates IDs/body, preserves employee zeroes/case and refuses reassignment', async () => {
  const co = await company(),
    other = await company(),
    a = await customer(),
    b = await customer();
  await empty(await create(co, a.id, ' 001a '));
  assert.equal((await member(co, a.id)).employeeNo, '001a');
  await error(await create(co, b.id, '001a'), 409, 'DUPLICATE_RESOURCE');
  await error(await create(co, a.id, '002'), 409, 'DUPLICATE_RESOURCE');
  await error(await create(other, a.id, '001a'), 409, 'DUPLICATE_RESOURCE');
  await empty(await create(other, b.id, '001a'));
  const c = await customer();
  await empty(await create(co, c.id, '001A'));
  for (const input of [
    {},
    { customerSeq: a.id, employeeNo: ' ', role: 'MEMBER' },
    { customerSeq: String(a.id), employeeNo: '004', role: 'MEMBER' },
    { customerSeq: a.id, employeeNo: 123, role: 'MEMBER' },
    { customerSeq: a.id, employeeNo: '004', role: 'SYSTEM_ADMIN' },
    { customerSeq: a.id, employeeNo: '004', role: 'MEMBER', status: 'ACTIVE' },
  ])
    await error(
      await request(`/companies/${co}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
        body: JSON.stringify(input),
      }),
      400,
      'INVALID_REQUEST',
    );
  const id = (await member(co, a.id)).membershipSeq;
  for (const input of [
    {},
    { role: null },
    { status: null },
    { organizationSeq: other },
    { employeeNo: '004' },
    { customerSeq: b.id },
    { phoneNumber: phone() },
    { role: 'SYSTEM_ADMIN' },
    { status: 'PENDING' },
  ])
    await error(await patch(id, input), 400, 'INVALID_REQUEST');
  for (const idValue of ['0', '-1', '1.5', '2147483648', 'bad']) {
    await error(await request(`/companies/${idValue}/members`), 400, 'INVALID_REQUEST');
    await error(await patch(idValue, { role: 'MEMBER' }), 400, 'INVALID_REQUEST');
    await error(await remove(idValue), 400, 'INVALID_REQUEST');
  }
  await error(await create(2147483647, a.id), 404, 'NOT_FOUND');
  await error(await create(co, 2147483647), 404, 'NOT_FOUND');
  await error(await patch(2147483647, { role: 'MEMBER' }), 404, 'NOT_FOUND');
  await error(await remove(2147483647), 404, 'NOT_FOUND');
});

test('inactive/withdrawn checks prevent new registrations and activation without deleting records', async () => {
  const co = await company(),
    inactive = await company('INACTIVE'),
    a = await customer(),
    withdrawn = await customer('WITHDRAWN');
  await error(await create(inactive, a.id), 409, 'INVALID_STATE');
  await error(await create(co, withdrawn.id), 409, 'INVALID_STATE');
  await empty(await create(co, a.id));
  const m = await member(co, a.id);
  await empty(await patch(m.membershipSeq, { status: 'INACTIVE' }));
  await error(await create(await company(), a.id), 409, 'DUPLICATE_RESOURCE');
  await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [co]);
  await error(await patch(m.membershipSeq, { status: 'ACTIVE' }), 409, 'INVALID_STATE');
  assert.equal((await members(co)).data.length, 1);
  await pool.query("UPDATE organizations SET status='ACTIVE' WHERE organization_seq=$1", [co]);
  await empty(await patch(m.membershipSeq, { status: 'ACTIVE' }));
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [a.id]);
  await error(await patch(m.membershipSeq, { status: 'ACTIVE' }), 409, 'INVALID_STATE');
  await empty(await patch(m.membershipSeq, { status: 'INACTIVE' }));
  await empty(await remove(m.membershipSeq));
});

test('unlink deletes only membership, preserves customer/PIN/order and permits another company', async () => {
  const co = await company(),
    other = await company(),
    cu = await customer();
  await empty(await create(co, cu.id));
  const m = await member(co, cu.id);
  const order = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [cu.id])
  ).rows[0].order_seq;
  const address = {
    name: '수령인',
    phoneNumber: cu.phoneNumber,
    roadAddress: '테스트로 1',
    jibunAddress: '테스트동 1',
    detailAddress: '',
    dongName: '테스트동',
    postalCode: '12345',
    latitude: 37.5,
    longitude: 127,
  };
  const pin = (
    await pool.query(
      'INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2::jsonb) RETURNING personal_pin_seq',
      [cu.id, JSON.stringify(address)],
    )
  ).rows[0].personal_pin_seq;
  await empty(await remove(m.membershipSeq));
  assert.deepEqual(await members(co), { data: [], hasNext: false });
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE customer_seq=$1', [cu.id])).rows[0]
      .count,
    '1',
  );
  assert.equal(
    (await pool.query('SELECT customer_seq FROM personal_pins WHERE personal_pin_seq=$1', [pin]))
      .rows[0].customer_seq,
    cu.id,
  );
  assert.equal(
    (await pool.query('SELECT customer_seq FROM orders WHERE order_seq=$1', [order])).rows[0]
      .customer_seq,
    cu.id,
  );
  await error(await remove(m.membershipSeq), 404, 'NOT_FOUND');
  await empty(await create(other, cu.id, 'NEW'));
  assert.notEqual((await member(other, cu.id)).membershipSeq, m.membershipSeq);
});

test('CSV creates new customers and links existing unaffiliated customers with default display/state', async () => {
  const co = await company(),
    existing = await customer(),
    number = phone();
  const content =
    '\ufeff' + header + `001a," 김,민수 ",${number}\n002,변경 고객,${existing.phoneNumber}`;
  await empty(await upload(co, content));
  const list = await members(co);
  assert.equal(list.data.length, 2);
  const linked = list.data.find((row) => row.customer.customerSeq === existing.id);
  assert.equal(linked.customer.name, '변경 고객');
  assert.equal(linked.membership.employeeNo, '002');
  const fresh = list.data.find((row) => row.customer.phoneNumber === number);
  assert.equal(fresh.customer.name, '김,민수');
  assert.equal(fresh.membership.employeeNo, '001a');
  for (const row of list.data) {
    assert.equal(row.membership.role, 'MEMBER');
    assert.equal(row.membership.status, 'ACTIVE');
    assert.equal(row.customer.status, 'ACTIVE');
  }
});

test('CSV updates existing employee name/phone while retaining IDs, representative/status and historical order snapshot', async () => {
  const co = await company(),
    cu = await customer(),
    omitted = await customer();
  await empty(await create(co, cu.id, '001', randomUUID(), 'ORG_ADMIN'));
  await empty(await create(co, omitted.id, '002'));
  const m = await member(co, cu.id);
  await empty(await patch(m.membershipSeq, { status: 'INACTIVE' }));
  const order = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [cu.id])
  ).rows[0].order_seq;
  await pool.query(
    'INSERT INTO order_parcels(order_seq,parcel_position,origin_name,origin_phone_number) VALUES($1,1,$2,$3)',
    [order, cu.name, cu.phoneNumber],
  );
  const next = phone();
  await empty(await upload(co, header + `001,새 이름,${next}`));
  const after = await member(co, cu.id);
  assert.equal(after.membershipSeq, m.membershipSeq);
  assert.equal(after.role, 'ORG_ADMIN');
  assert.equal(after.status, 'INACTIVE');
  const detail = await request('/customers/' + cu.id);
  assert.equal(detail.status, 200);
  assert.deepEqual((await detail.json()).data, {
    customerSeq: cu.id,
    name: '새 이름',
    phoneNumber: next,
    status: 'ACTIVE',
  });
  assert.equal((await members(co)).data.length, 2);
  const old = (
    await pool.query(
      'SELECT origin_name,origin_phone_number FROM order_parcels WHERE order_seq=$1',
      [order],
    )
  ).rows[0];
  assert.deepEqual(old, { origin_name: cu.name, origin_phone_number: cu.phoneNumber });
  await empty(await upload(co, header + `001,새 이름,${next}`));
  assert.equal((await member(co, cu.id)).membershipSeq, m.membershipSeq);
  const blocked = await request('/customers/' + cu.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber: phone() }),
  });
  await error(blocked, 400, 'INVALID_REQUEST');
});

test('CSV validates the whole batch before changes and never echoes bad phone/name fields', async () => {
  const co = await company(),
    number = phone();
  for (const content of [
    header + `001,PrivateName,${number}\n001,Other,${phone()}`,
    header + `001,PrivateName,${number}\n002,Other,${number}`,
    header + `001,PrivateName,${number}\n002,Other,010-bad`,
  ]) {
    const body = await error(await upload(co, content), 422, 'VALIDATION_FAILED');
    assert.ok(!JSON.stringify(body).includes('PrivateName'));
    assert.ok(!JSON.stringify(body).includes(number));
    assert.equal((await members(co)).data.length, 0);
    assert.equal(
      (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
        .count,
      '0',
    );
  }
});

test('CSV rejects other-company membership, another employee number and phone ownership conflicts atomically', async () => {
  const co = await company(),
    other = await company(),
    a = await customer(),
    b = await customer();
  await empty(await create(co, a.id, '001'));
  await empty(await create(other, b.id, 'OTHER'));
  const number = phone();
  for (const [row, reason] of [
    [`002,Other,${b.phoneNumber}`, 'OTHER_COMPANY_MEMBERSHIP'],
    [`002,Other,${a.phoneNumber}`, 'EMPLOYEE_NO_CONFLICT'],
    [`001,Other,${b.phoneNumber}`, 'PHONE_NUMBER_CONFLICT'],
  ]) {
    const body = await error(
      await upload(co, header + `NEW,새 고객,${number}\n` + row),
      422,
      'VALIDATION_FAILED',
    );
    assert.ok(body.error.details.some((item) => item.reason === reason));
    assert.equal(
      (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
        .count,
      '0',
    );
    assert.equal((await member(co, a.id)).employeeNo, '001');
  }
});

test('CSV refuses withdrawn customers and inactive companies without reviving or partially saving rows', async () => {
  const co = await company(),
    inactive = await company('INACTIVE'),
    cu = await customer('WITHDRAWN');
  const body = await error(
    await upload(co, header + `001,신규,${phone()}\n002,탈퇴,${cu.phoneNumber}`),
    422,
    'VALIDATION_FAILED',
  );
  assert.ok(body.error.details.some((item) => item.reason === 'CUSTOMER_WITHDRAWN'));
  assert.equal((await members(co)).data.length, 0);
  await error(await upload(inactive, header + `001,신규,${phone()}`), 409, 'INVALID_STATE');
  assert.equal(
    (await pool.query('SELECT status FROM customers WHERE customer_seq=$1', [cu.id])).rows[0]
      .status,
    'WITHDRAWN',
  );
  const existing = await customer();
  await empty(await create(co, existing.id, '003'));
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [existing.id]);
  await error(await upload(co, header + `003,복구 시도,${phone()}`), 422, 'VALIDATION_FAILED');
});

test('multipart validates file count, fields, type, encoding, byte cap and row cap with no persistence', async () => {
  const co = await company();
  const content = header + `001,고객,${phone()}`;
  await error(
    await upload(co, content, randomUUID(), base, cookie, 'employees.xlsx'),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  await error(
    await upload(co, content, randomUUID(), base, cookie, 'employees.csv', 'application/pdf'),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  for (const bad of [
    '',
    header,
    'name,phoneNumber\nA,0101',
    header + '001,"unclosed,0101',
    Buffer.from([0xff, 0xfe, 0x61]),
  ])
    await error(await upload(co, bad), 400, 'INVALID_REQUEST');
  await error(await upload(co, 'x'.repeat(CSV_MAX_BYTES + 1)), 413, 'PAYLOAD_TOO_LARGE');
  const rows = Array.from(
    { length: 1001 },
    (_, i) => `${i},Name,010${String(i).padStart(8, '0')}`,
  ).join('\n');
  await error(await upload(co, header + rows), 413, 'PAYLOAD_TOO_LARGE');
  for (const mode of ['missing', 'extra', 'double', 'wrong']) {
    const form = new FormData();
    if (mode !== 'missing')
      form.append(
        mode === 'wrong' ? 'other' : 'file',
        new Blob([content], { type: 'text/csv' }),
        'file.csv',
      );
    if (mode === 'double')
      form.append('file', new Blob([content], { type: 'text/csv' }), 'other.csv');
    if (mode === 'extra') form.append('role', 'ORG_ADMIN');
    await error(
      await request(`/companies/${co}/members/import`, {
        method: 'POST',
        headers: { 'Idempotency-Key': randomUUID() },
        body: form,
      }),
      400,
      'INVALID_REQUEST',
    );
  }
  await error(
    await request(`/companies/${co}/members/import`, {
      method: 'POST',
      headers: { 'Idempotency-Key': randomUUID(), 'Content-Type': 'application/json' },
      body: '{}',
    }),
    415,
    'UNSUPPORTED_MEDIA_TYPE',
  );
  await error(await upload(co, content, 'bad'), 400, 'INVALID_REQUEST');
  const noKey = new FormData();
  noKey.append('file', new Blob([content], { type: 'text/csv' }), 'file.csv');
  await error(
    await request(`/companies/${co}/members/import`, { method: 'POST', body: noKey }),
    400,
    'INVALID_REQUEST',
  );
  assert.deepEqual(await members(co), { data: [], hasNext: false });
});

test('manual/CSV keys are per admin and bind operation, company and content while ignoring multipart boundary/name', async () => {
  const co = await company(),
    other = await company(),
    cu = await customer(),
    key = randomUUID();
  await empty(await create(co, cu.id, '001', key));
  await empty(await create(co, cu.id, ' 001 ', key.toUpperCase(), 'MEMBER', baseB));
  await error(await create(co, cu.id, '002', key), 422, 'IDEMPOTENCY_KEY_REUSED');
  await error(await create(other, cu.id, '001', key), 422, 'IDEMPOTENCY_KEY_REUSED');
  await error(
    await upload(co, header + `001,CSV,${cu.phoneNumber}`, key),
    422,
    'IDEMPOTENCY_KEY_REUSED',
  );
  const another = await account();
  await error(
    await create(co, cu.id, '001', key, 'MEMBER', base, another.cookie),
    409,
    'DUPLICATE_RESOURCE',
  );
  const importKey = randomUUID(),
    content = header + `002,CSV,${phone()}`;
  await empty(await upload(co, content, importKey));
  await empty(await upload(co, content, importKey, baseB, cookie, 'renamed.csv'));
  await error(await upload(co, content + '\n', importKey), 422, 'IDEMPOTENCY_KEY_REUSED');
  await error(await upload(other, content, importKey), 422, 'IDEMPOTENCY_KEY_REUSED');
  await empty(await upload(co, content, importKey, base, another.cookie));
  assert.equal((await members(co)).data.length, 2);
});

test('durable retries survive app restart and unlink without recreating a deleted membership or duplicate audit', async () => {
  const co = await company(),
    cu = await customer(),
    key = randomUUID();
  await empty(await create(co, cu.id, '001', key));
  const m = await member(co, cu.id);
  const restarted = await start();
  await empty(await create(co, cu.id, '001', key, 'MEMBER', await restarted.getUrl()));
  const successful = await pool.query(
    "SELECT count(*) FROM audit_logs WHERE action='MEMBERSHIP_CREATED' AND target_seq=$1 AND result='SUCCESS'",
    [m.membershipSeq],
  );
  assert.equal(successful.rows[0].count, '1');
  await empty(await remove(m.membershipSeq));
  await empty(await create(co, cu.id, '001', key));
  assert.equal((await members(co)).data.length, 0);
  await empty(await create(co, cu.id, '001'));
  assert.notEqual((await member(co, cu.id)).membershipSeq, m.membershipSeq);
});

test('in-flight keys and membership writes return retryable conflicts without retaining failed receipts', async () => {
  const co = await company(),
    cu = await customer(),
    key = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    assert.equal(await repository.lockKey(client, adminId, key), true);
    await error(await create(co, cu.id, '001', key), 409, 'REQUEST_IN_PROGRESS');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
  await empty(await create(co, cu.id, '001', key));
  const m = await member(co, cu.id);
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    assert.equal(await repository.lockWrites(lock), true);
    await error(await patch(m.membershipSeq, { role: 'ORG_ADMIN' }), 409, 'REQUEST_IN_PROGRESS');
    await error(await upload(co, header + `002,새 고객,${phone()}`), 409, 'REQUEST_IN_PROGRESS');
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  await empty(await patch(m.membershipSeq, { role: 'ORG_ADMIN' }));
});

test('concurrent uploads across app instances create one customer/membership and one successful batch audit', async () => {
  const co = await company(),
    number = phone(),
    key = randomUUID(),
    content = header + `001,동시 고객,${number}`;
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) => upload(co, content, key, i % 2 ? base : baseB)),
  );
  assert.ok(responses.some((response) => response.status === 204));
  for (const response of responses) assert.ok([204, 409].includes(response.status));
  await empty(await upload(co, content, key));
  assert.equal((await members(co)).data.length, 1);
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
      .count,
    '1',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM audit_logs WHERE action='MEMBERS_IMPORTED' AND target_seq=$1 AND result='SUCCESS'",
        [co],
      )
    ).rows[0].count,
    '1',
  );
});

test('concurrent companies cannot acquire the same phone/customer and retries never move the winner', async () => {
  const co = await company(),
    other = await company(),
    number = phone(),
    content = header + `001,경합 고객,${number}`;
  const responses = await Promise.all([
    upload(co, content),
    upload(other, content, randomUUID(), baseB),
  ]);
  assert.equal(responses.filter((response) => response.status === 204).length, 1);
  for (const response of responses) assert.ok([204, 409, 422].includes(response.status));
  assert.equal((await members(co)).data.length + (await members(other)).data.length, 1);
  assert.equal(
    (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [number])).rows[0]
      .count,
    '1',
  );
  const loser = (await members(co)).data.length ? other : co;
  await error(await upload(loser, content), 422, 'VALIDATION_FAILED');
});

test('CSV receipt failure rolls back phone/name changes, new customers, memberships and success audit', async () => {
  const co = await company(),
    cu = await customer();
  await empty(await create(co, cu.id));
  const key = randomUUID(),
    newPhone = phone(),
    otherPhone = phone();
  const content = header + `001,실패 이름,${newPhone}\n002,실패 신규,${otherPhone}`;
  await pool.query(
    "CREATE FUNCTION api_idempotency.fail_members_receipt_37() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test receipt failure'; END $$",
  );
  try {
    await pool.query(
      'CREATE TRIGGER fail_members_receipt_37 BEFORE INSERT ON api_idempotency.membership_writes FOR EACH ROW EXECUTE FUNCTION api_idempotency.fail_members_receipt_37()',
    );
    await error(await upload(co, content, key), 500, 'INTERNAL_ERROR');
    const old = (
      await pool.query('SELECT name,phone_number FROM customers WHERE customer_seq=$1', [cu.id])
    ).rows[0];
    assert.deepEqual(old, { name: cu.name, phone_number: cu.phoneNumber });
    assert.equal((await members(co)).data.length, 1);
    assert.equal(
      (await pool.query('SELECT count(*) FROM customers WHERE phone_number=$1', [otherPhone]))
        .rows[0].count,
      '0',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM api_idempotency.membership_writes WHERE idempotency_key=$1',
          [key],
        )
      ).rows[0].count,
      '0',
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM audit_logs WHERE action='MEMBERS_IMPORTED' AND target_seq=$1 AND result='SUCCESS'",
          [co],
        )
      ).rows[0].count,
      '0',
    );
  } finally {
    await pool.query(
      'DROP TRIGGER IF EXISTS fail_members_receipt_37 ON api_idempotency.membership_writes',
    );
    await pool.query('DROP FUNCTION api_idempotency.fail_members_receipt_37()');
  }
  await empty(await upload(co, content, key));
  assert.equal((await members(co)).data.length, 2);
});

test('audit failure rolls back representative/status changes and unlink, recording only the failed attempt', async () => {
  const co = await company(),
    cu = await customer();
  await empty(await create(co, cu.id));
  const m = await member(co, cu.id);
  await pool.query(
    "CREATE FUNCTION public.fail_members_audit_37() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_type='MEMBERSHIP' AND NEW.result='SUCCESS' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$",
  );
  try {
    await pool.query(
      'CREATE TRIGGER fail_members_audit_37 BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION public.fail_members_audit_37()',
    );
    await error(
      await patch(m.membershipSeq, { role: 'ORG_ADMIN', status: 'INACTIVE' }),
      500,
      'INTERNAL_ERROR',
    );
    await error(await remove(m.membershipSeq), 500, 'INTERNAL_ERROR');
    const after = await member(co, cu.id);
    assert.equal(after.role, 'MEMBER');
    assert.equal(after.status, 'ACTIVE');
    const failures = await pool.query(
      "SELECT action,result FROM audit_logs WHERE target_type='MEMBERSHIP' AND target_seq=$1 AND result='FAILED' ORDER BY audit_log_seq",
      [m.membershipSeq],
    );
    assert.deepEqual(failures.rows, [
      { action: 'MEMBERSHIP_UPDATED', result: 'FAILED' },
      { action: 'MEMBERSHIP_REMOVED', result: 'FAILED' },
    ]);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS fail_members_audit_37 ON audit_logs');
    await pool.query('DROP FUNCTION public.fail_members_audit_37()');
  }
});

test('CSV rechecks customer status after acquiring a row locked by a concurrent withdrawal', async () => {
  const co = await company(),
    cu = await customer(),
    newPhone = phone();
  await empty(await create(co, cu.id));
  const lock = await pool.connect();
  let pending,
    committed = false;
  try {
    await lock.query('BEGIN');
    await lock.query('SELECT customer_seq FROM customers WHERE customer_seq=$1 FOR UPDATE', [
      cu.id,
    ]);
    pending = upload(co, header + `001,변경 시도,${newPhone}`);
    let waiting = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = await pool.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT customer_seq FROM customers WHERE customer_seq=ANY%') AS waiting",
      );
      if (result.rows[0].waiting) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(waiting, true);
    await lock.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [cu.id]);
    await lock.query('COMMIT');
    committed = true;
    await error(await pending, 422, 'VALIDATION_FAILED');
    const after = (
      await pool.query('SELECT status,phone_number FROM customers WHERE customer_seq=$1', [cu.id])
    ).rows[0];
    assert.deepEqual(after, { status: 'WITHDRAWN', phone_number: cu.phoneNumber });
  } finally {
    if (!committed) await lock.query('ROLLBACK');
    lock.release();
    if (pending) await pending;
  }
});

test('OpenAPI contains five protected operations, CSV upload shape, representative labels and 204 responses', async () => {
  const document = await (await fetch(base + '/api/docs-json')).json();
  for (const [path, method] of [
    ['/api/companies/{id}/members', 'get'],
    ['/api/companies/{id}/members', 'post'],
    ['/api/companies/{id}/members/import', 'post'],
    ['/api/members/{id}', 'patch'],
    ['/api/members/{id}', 'delete'],
  ]) {
    const operation = document.paths[path][method];
    assert.deepEqual(operation.security, [{ adminSession: [] }]);
    if (method !== 'get') assert.ok(!operation.responses['204'].content);
  }
  const upload = document.paths['/api/companies/{id}/members/import'].post;
  assert.equal(
    upload.requestBody.content['multipart/form-data'].schema.properties.file.format,
    'binary',
  );
  assert.equal(upload.parameters.find((item) => item.name === 'Idempotency-Key').required, true);
  assert.deepEqual(Object.keys(document.components.schemas.UpdateMemberDto.properties).sort(), [
    'role',
    'status',
  ]);
  assert.match(
    document.components.schemas.MembershipResponseDto.properties.role.description,
    /대표자/,
  );
});
