const { testMembership } = require('./helpers/membership.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
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
const pool = createTestPool();
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
  await testMembership(pool, {
    customerSeq: customer,
    organizationSeq: company,
    employeeNo: randomUUID(),
    role,
    status: memberStatus,
  });
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
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
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

test('all active administrator roles can manage personal pins', async () => {
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const headers = await admin(role),
      f = await fixture(),
      p = await personal(f, address(), {}, headers);
    assert.equal(
      (await request('GET', '/customers/' + f.customer + '/pins', undefined, headers)).status,
      200,
    );
    assert.equal(
      (await request('PATCH', '/pins/' + p.personalPinSeq, { label: role }, headers)).status,
      200,
    );
  }
});

test('retired company PIN routes return 404 and leave legacy data intact', async () => {
  const f = await fixture({ role: 'ORG_ADMIN' });
  const id = (
    await pool.query(
      'INSERT INTO company_pins(organization_seq,address_data) VALUES($1,$2) RETURNING company_pin_seq',
      [f.company, address()],
    )
  ).rows[0].company_pin_seq;
  const before = await stored(id, true);
  for (const headers of [f.ai, adminHeaders])
    for (const [method, path, body] of [
      ['GET', '/companies/' + f.company + '/pins'],
      ['POST', '/companies/' + f.company + '/pins', { addressData: address() }],
      ['PATCH', '/company-pins/' + id, { label: '금지' }],
    ])
      assert.equal((await request(method, path, body, headers)).status, 404);
  assert.deepEqual(await stored(id, true), before);
});

test('another caller cannot list, create or edit private pins', async () => {
  const owner = await fixture();
  const other = await fixture();
  const p = await personal(owner);
  for (const [method, path, body] of [
    ['GET', `/customers/${owner.customer}/pins`],
    ['POST', `/customers/${owner.customer}/pins`, { addressData: address() }],
    ['PATCH', `/pins/${p.personalPinSeq}`, { label: '침범' }],
  ])
    await error(await request(method, path, body, other.ai), 403, 'FORBIDDEN');
  assert.equal((await stored(p.personalPinSeq)).label, null);
  await pool.query(
    'UPDATE memberships SET organization_seq=$1,department_seq=(SELECT department_seq FROM departments WHERE organization_seq=$1 LIMIT 1) WHERE customer_seq=$2',
    [owner.company, other.customer],
  );
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
      `/customers/${f.customer}/pins`,
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

test('withdrawal blocks personal access for callers and administrators', async () => {
  const f = await fixture();
  const p = await personal(f);
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
});

test('duplicate personal addresses use existing normalized DB identity, independent of labels and request keys', async () => {
  const f = await fixture();
  const data = address({ name: 'TEST Name', detailAddress: '가 101호' });
  const p = await personal(
    f,
    data,
    { label: '첫 주소' },
    { ...f.ai, 'Idempotency-Key': randomUUID() },
  );
  const duplicate = {
    ...data,
    name: '  test   name  ',
    detailAddress: data.detailAddress.normalize('NFD'),
  };
  await error(
    await request(
      'POST',
      `/customers/${f.customer}/pins`,
      { label: '다른 별칭', addressData: duplicate },
      f.ai,
    ),
    409,
    'DUPLICATE_RESOURCE',
  );
  const other = await fixture();
  await personal(other, data);
  assert.equal((await stored(p.personalPinSeq)).label, '첫 주소');
  const concurrent = address();
  const results = await Promise.all(
    [1, 2].map(() =>
      request('POST', `/customers/${f.customer}/pins`, { addressData: concurrent }, f.ai),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
});

test('stale expectedVersion is accepted without a re-read and omitted fields survive', async () => {
  const f = await fixture();
  const data = address({ detailAddress: '101호' });
  const p = await personal(f, data, { label: '집' });
  assert.equal(
    (
      await success(
        await request('PATCH', `/pins/${p.personalPinSeq}`, {
          addressData: { ...data, detailAddress: '102호' },
        }),
      )
    ).version,
    2,
  );
  assert.equal(
    (
      await success(
        await request(
          'PATCH',
          `/pins/${p.personalPinSeq}`,
          { addressData: { ...data, detailAddress: '103호' }, expectedVersion: 1 },
          f.ai,
        ),
      )
    ).version,
    3,
  );
  assert.equal((await stored(p.personalPinSeq)).address_data.detailAddress, '103호');
  assert.equal((await stored(p.personalPinSeq)).label, '집');
  const cleared = await success(
    await request('PATCH', `/pins/${p.personalPinSeq}`, { label: null }, f.ai),
  );
  assert.equal(cleared.version, 4);
  assert.equal((await stored(p.personalPinSeq)).address_data.detailAddress, '103호');
  assert.equal(
    (await success(await request('PATCH', `/pins/${p.personalPinSeq}`, { label: null }, f.ai)))
      .version,
    4,
  );
});

test('concurrent partial updates preserve unrelated fields without a version conflict', async () => {
  const f = await fixture();
  const data = address();
  const p = await personal(f, data);
  const results = await Promise.all([
    request('PATCH', `/pins/${p.personalPinSeq}`, { label: '새 별칭', expectedVersion: 1 }, f.ai),
    request('PATCH', `/pins/${p.personalPinSeq}`, {
      addressData: { ...data, detailAddress: '새 상세주소' },
      expectedVersion: 1,
    }),
  ]);
  for (const response of results) assert.equal(response.status, 200);
  const final = await stored(p.personalPinSeq);
  assert.equal(final.label, '새 별칭');
  assert.equal(final.address_data.detailAddress, '새 상세주소');
  assert.equal(final.version, 3);
});

test('duplicate edits roll back all fields and version rather than partially saving', async () => {
  const f = await fixture();
  const first = await personal(f, address(), { label: '보존' });
  const duplicate = address();
  await personal(f, duplicate);
  const previous = await stored(first.personalPinSeq);
  await error(
    await request('PATCH', `/pins/${first.personalPinSeq}`, {
      label: '저장하면 안 됨',
      addressData: duplicate,
    }),
    409,
    'DUPLICATE_RESOURCE',
  );
  assert.deepEqual(await stored(first.personalPinSeq), previous);
});

test('literal search, pagination and generated search updates stay scoped', async () => {
  const f = await fixture();
  for (let i = 0; i < 3; i++)
    await personal(f, address({ name: '검색 수령인' }), { label: i === 0 ? '100%_특별' : '검색' });
  let response = await request('GET', `/customers/${f.customer}/pins?limit=2`, undefined, f.ai);
  let body = await response.json();
  assert.equal(body.data.length, 2);
  assert.equal(body.hasNext, true);
  assert.equal(body.total_count, 3);
  const pastEnd = await request('GET', `/customers/${f.customer}/pins?offset=100`, undefined, f.ai);
  assert.deepEqual(await pastEnd.json(), { data: [], hasNext: false, total_count: 3 });
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
  assert.equal(body.total_count, 1);
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
});

test('invalid or incomplete addresses and scope overrides are rejected without storing data', async () => {
  const f = await fixture();
  const p = await personal(f);
  const badAddresses = [
    null,
    [],
    {},
    { ...address(), latitude: 37.5 },
    { ...address(), longitude: 127 },
    { ...address(), latitude: null },
    { ...address(), longitude: null },
    { ...address(), name: ' ' },
    { ...address(), phoneNumber: '010-1234-5678' },
    { ...address(), postalCode: '1234' },
    { ...address(), detailAddress: null },
    { ...address(), private: true },
  ];
  for (const data of badAddresses)
    await error(
      await request('POST', `/customers/${f.customer}/pins`, { addressData: data }, f.ai),
      400,
      'INVALID_REQUEST',
    );
  for (const body of [
    {},
    { expectedVersion: 1 },
    { version: 1, label: '변경' },
    { customerSeq: f.customer, label: '변경' },
    { addressData: { detailAddress: '부분 주소' } },
    { label: 123 },
    { label: '변경', paymentMethodType: 'credit' },
  ])
    await error(
      await request('PATCH', `/pins/${p.personalPinSeq}`, body, f.ai),
      400,
      'INVALID_REQUEST',
    );
  for (const path of [
    `/customers/${f.customer}/pins?limit=101`,
    `/customers/${f.customer}/pins?offset=-1`,
    '/customers/2147483648/pins',
    '/customers/abc/pins',
  ])
    await error(await request('GET', path), 400, 'INVALID_REQUEST');
  const noDetail = address();
  delete noDetail.detailAddress;
  await personal(f, noDetail, {}, f.ai);
  await error(
    await request(
      'POST',
      `/customers/${f.customer}/pins`,
      { addressData: address({ detailAddress: '' }) },
      f.ai,
    ),
    409,
    'DUPLICATE_RESOURCE',
  );
  await personal(f, address({ roadAddress: '예시로 13', detailAddress: '' }), {}, f.ai);
});

test('editing a referenced pin leaves existing order address snapshots and order version unchanged', async () => {
  const f = await fixture();
  const p = await personal(f);
  const order = (
    await pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq', [
      f.customer,
    ])
  ).rows[0].order_seq;
  const parcel = (
    await pool.query(
      `INSERT INTO order_parcels(order_seq,parcel_position,origin_pin_scope,origin_pin_seq,origin_detail_address)
    VALUES($1,1,'PERSONAL',$2,'접수 당시 주소') RETURNING order_parcel_seq`,
      [order, p.personalPinSeq],
    )
  ).rows[0].order_parcel_seq;
  const beforeOrder = (await pool.query('SELECT * FROM orders WHERE order_seq=$1', [order]))
    .rows[0];
  await success(
    await request(
      'PATCH',
      `/pins/${p.personalPinSeq}`,
      { addressData: address({ detailAddress: '수정된 주소' }) },
      f.ai,
    ),
  );
  assert.equal(
    (
      await pool.query(
        'SELECT origin_detail_address FROM order_parcels WHERE order_parcel_seq=$1',
        [parcel],
      )
    ).rows[0].origin_detail_address,
    '접수 당시 주소',
  );
  assert.deepEqual(
    (await pool.query('SELECT * FROM orders WHERE order_seq=$1', [order])).rows[0],
    beforeOrder,
  );
});

test('audit success is atomic with writes and contains no address or phone; failure rolls back changes', async () => {
  const f = await fixture();
  const p = await personal(f);
  const requestId = randomUUID();
  await success(
    await request(
      'PATCH',
      `/pins/${p.personalPinSeq}`,
      { label: '기록' },
      { ...f.ai, 'X-Request-Id': requestId },
    ),
  );
  const audit = (
    await pool.query("SELECT * FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'", [
      requestId,
    ])
  ).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_type, 'AI');
  assert.equal(audit[0].actor_name, 'AI');
  assert.equal(audit[0].target_seq, p.personalPinSeq);
  assert.deepEqual(audit[0].metadata, {});
  const service = app.get(AuditService);
  const original = service.recordSuccess;
  const before = await stored(p.personalPinSeq);
  service.recordSuccess = async () => {
    throw new Error('private audit failure');
  };
  try {
    await error(
      await request('PATCH', `/pins/${p.personalPinSeq}`, { label: '롤백 대상' }),
      500,
      'INTERNAL_ERROR',
    );
    assert.deepEqual(await stored(p.personalPinSeq), before);
    const data = address();
    await error(
      await request('POST', `/customers/${f.customer}/pins`, { addressData: data }),
      500,
      'INTERNAL_ERROR',
    );
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM personal_pins WHERE customer_seq=$1 AND address_data=$2',
          [f.customer, data],
        )
      ).rows[0].count,
      '0',
    );
  } finally {
    service.recordSuccess = original;
  }
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
