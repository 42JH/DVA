const { testMembership } = require('./helpers/membership.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestPool, startTestApp, businessHeaders } = require('./helpers/application.cjs');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { OrganizationsRepository } = require('../dist/organizations/organizations.repository');
const { hashPassword } = require('../dist/auth/password');
const pool = createTestPool();
const apps = [];
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
  ...extra,
});
const search = (query, headers = businessHeaders()) =>
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
  assert.deepEqual(Object.keys(body).sort(), ['data', 'hasNext', 'total_count']);
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
  assert.equal(
    (await pool.query("SELECT to_regclass('public.company_pins') AS name")).rows[0].name,
    null,
  );
  app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
  base = await app.getUrl();
  passwordHash = await hashPassword(password);
  adminHeaders = await account();
});
after(async () => {
  for (const application of apps) await application.close();
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
async function recipient(
  c,
  {
    name = '공식 배송 담당자',
    status = 'ACTIVE',
    membershipStatus = 'ACTIVE',
    employeeNo = marker(),
    addressData = address(),
  } = {},
) {
  const { name: ignoredName, phoneNumber: ignoredPhone, ...ownAddress } = addressData || {};
  const phoneNumber = '010' + String(randomInt(10000000, 100000000));
  const customerSeq = (
    await pool.query(
      'INSERT INTO customers(name,phone_number,status,address_data) VALUES($1,$2,$3,$4) RETURNING customer_seq',
      [name, phoneNumber, status, addressData ? ownAddress : null],
    )
  ).rows[0].customer_seq;
  const membershipSeq = (
    await testMembership(pool, {
      customerSeq,
      organizationSeq: c.id,
      employeeNo,
      status: membershipStatus,
    })
  ).rows[0].membership_seq;
  const departmentSeq = (
    await pool.query('SELECT department_seq FROM memberships WHERE membership_seq=$1', [
      membershipSeq,
    ])
  ).rows[0].department_seq;
  return {
    organizationSeq: c.id,
    organizationName: c.name,
    membershipSeq,
    customerSeq,
    departmentSeq,
    departmentName: '검증 부서',
    addressData: addressData ? { ...ownAddress, name, phoneNumber } : null,
  };
}

test('active member addresses are shared across companies without any company PIN or caller prerequisite', async () => {
  const c = await company();
  const member = await recipient(c);
  for (const headers of [
    businessHeaders(),
    { ...businessHeaders(), call_session_seq: '2147483647' },
  ])
    assert.deepEqual(await result(await search({ q: c.name }, headers)), {
      data: [member],
      hasNext: false,
      total_count: 1,
    });
});

test('multiple recipients in homonymous companies have stable customer identities and pagination', async () => {
  const name = marker(),
    first = await company(name),
    second = await company(name);
  const members = [await recipient(first), await recipient(first), await recipient(second)];
  const collected = [];
  for (let offset = 0; offset < 3; offset++) {
    const body = await result(await search({ q: name, limit: '1', offset: String(offset) }));
    assert.equal(body.hasNext, offset < 2);
    assert.equal(body.total_count, 3);
    collected.push(...body.data);
  }
  assert.deepEqual(collected, members);
  assert.deepEqual(await result(await search({ q: name, offset: '99' })), {
    data: [],
    hasNext: false,
    total_count: 3,
  });
});

test('inactive companies, inactive memberships, withdrawn customers and missing addresses are excluded', async () => {
  const token = marker(),
    active = await company(token + ' 활성'),
    inactive = await company(token + ' 비활성', 'INACTIVE');
  await recipient(inactive);
  await recipient(active, { membershipStatus: 'INACTIVE' });
  await recipient(active, { status: 'WITHDRAWN' });
  await recipient(active, { addressData: null });
  const visible = await recipient(active);
  assert.deepEqual(await result(await search({ q: token })), {
    data: [visible],
    hasNext: false,
    total_count: 1,
  });
});

test('optional departments and detail addresses are retained without inventing PIN IDs', async () => {
  const c = await company(),
    member = await recipient(c);
  await pool.query('UPDATE memberships SET department_seq=NULL WHERE membership_seq=$1', [
    member.membershipSeq,
  ]);
  await pool.query(
    "UPDATE customers SET address_data=address_data-'detailAddress' WHERE customer_seq=$1",
    [member.customerSeq],
  );
  const expected = {
    ...member,
    departmentSeq: null,
    departmentName: null,
    addressData: { ...member.addressData },
  };
  delete expected.addressData.detailAddress;
  const rows = (await result(await search({ q: c.name }))).data;
  assert.deepEqual(rows, [expected]);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    'addressData',
    'customerSeq',
    'departmentName',
    'departmentSeq',
    'membershipSeq',
    'organizationName',
    'organizationSeq',
  ]);
});

test('search combines company, department, current recipient and address terms with normalization', async () => {
  const c = await company();
  const member = await recipient(c, {
    name: 'Kim 가나',
    addressData: address({ detailAddress: '100%_101호' }),
  });
  for (const q of [
    c.name + ' 검증 부서',
    '검증 부서 ' + c.name,
    c.name + ' kim',
    '가나'.normalize('NFD'),
    member.addressData.phoneNumber,
    '공식로',
    '100%_',
    '01234',
  ])
    assert.ok(
      (await result(await search({ q }))).data.some(
        (row) => row.customerSeq === member.customerSeq,
      ),
      q,
    );
  for (const q of [c.name + ' 없는부서', "' OR TRUE --"])
    assert.deepEqual(await result(await search({ q })), {
      data: [],
      hasNext: false,
      total_count: 0,
    });
  assert.deepEqual((await result(await search({ q: '  ' + c.name + '\t\n 검증 부서  ' }))).data, [
    member,
  ]);
});

test('private PINs and employee numbers are not exposed or searched', async () => {
  const c = await company(),
    member = await recipient(c),
    secret = marker();
  await pool.query('UPDATE memberships SET employee_no=$1 WHERE membership_seq=$2', [
    secret,
    member.membershipSeq,
  ]);
  for (const [table, key, id] of [['personal_pins', 'customer_seq', member.customerSeq]])
    await pool.query('INSERT INTO ' + table + '(' + key + ',label,address_data) VALUES($1,$2,$3)', [
      id,
      secret,
      address({ name: secret }),
    ]);
  assert.deepEqual((await result(await search({ q: c.name }))).data, [member]);
  assert.deepEqual(await result(await search({ q: secret })), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
});

test('current profile updates are visible immediately without changing personal PINs', async () => {
  const c = await company(),
    member = await recipient(c);
  const saved = address({ name: '이전 이름', phoneNumber: member.addressData.phoneNumber });
  await pool.query('INSERT INTO personal_pins(customer_seq,address_data) VALUES($1,$2)', [
    member.customerSeq,
    saved,
  ]);
  const changed = { ...member.addressData, roadAddress: '새공식로 99' };
  const { name, phoneNumber, ...ownAddress } = changed;
  const response = await fetch(base + '/api/customers/' + member.customerSeq, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ name: '새 담당자', address: ownAddress }),
  });
  assert.equal(response.status, 204, await response.text());
  const row = (await result(await search({ q: c.name + ' 새공식로' }))).data[0];
  assert.equal(row.customerSeq, member.customerSeq);
  assert.equal(row.addressData.name, '새 담당자');
  assert.equal(row.addressData.phoneNumber, phoneNumber);
  assert.equal(row.addressData.roadAddress, '새공식로 99');
  assert.deepEqual(
    (
      await pool.query('SELECT address_data FROM personal_pins WHERE customer_seq=$1', [
        member.customerSeq,
      ])
    ).rows[0].address_data,
    saved,
  );
  assert.deepEqual((await result(await search({ q: c.name + ' 이전 이름' }))).data, []);
});

test('company rename, deactivation, address removal and membership unlinking affect the next read', async () => {
  const c = await company(),
    member = await recipient(c),
    renamed = marker();
  await pool.query('UPDATE organizations SET name=$1 WHERE organization_seq=$2', [renamed, c.id]);
  assert.deepEqual((await result(await search({ q: c.name }))).data, []);
  assert.equal((await result(await search({ q: renamed }))).data[0].organizationName, renamed);
  await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [c.id]);
  assert.deepEqual((await result(await search({ q: renamed }))).data, []);
  await pool.query("UPDATE organizations SET status='ACTIVE' WHERE organization_seq=$1", [c.id]);
  await pool.query('UPDATE customers SET address_data=NULL WHERE customer_seq=$1', [
    member.customerSeq,
  ]);
  assert.deepEqual((await result(await search({ q: renamed }))).data, []);
  const { name, phoneNumber, ...ownAddress } = member.addressData;
  await pool.query('UPDATE customers SET address_data=$1 WHERE customer_seq=$2', [
    ownAddress,
    member.customerSeq,
  ]);
  await pool.query('DELETE FROM memberships WHERE membership_seq=$1', [member.membershipSeq]);
  assert.deepEqual((await result(await search({ q: renamed }))).data, []);
});

test('administrator cookies cannot replace the directory service credential', async () => {
  const c = await company();
  await recipient(c);
  const authenticated = await result(await search({ q: c.name }));
  await error(await search({ q: c.name }, {}), 401, 'UNAUTHORIZED');
  await error(await search({ q: c.name }, { Authorization: 'Bearer wrong' }), 401, 'UNAUTHORIZED');
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const headers = await account(role);
    await error(await search({ q: c.name }, headers), 401, 'UNAUTHORIZED');
    assert.deepEqual(
      await result(await search({ q: c.name }, { ...headers, ...businessHeaders() })),
      authenticated,
    );
  }
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
    await search({ q: c.name }, { ...businessHeaders(), Origin: 'https://untrusted.invalid' }),
    403,
    'FORBIDDEN',
  );
});

test('shared delivery search keeps company management and complete member lists protected', async () => {
  const c = await company();
  await recipient(c);
  assert.equal((await fetch(base + '/api/companies')).status, 401);
  assert.equal((await fetch(base + '/api/companies/' + c.id)).status, 401);
  assert.equal((await fetch(base + '/api/companies/' + c.id + '/members')).status, 401);
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
  assert.deepEqual(await result(await search({ q: marker() })), {
    data: [],
    hasNext: false,
    total_count: 0,
  });
});

test('search is read-only and database failures are not transformed into empty successes', async () => {
  const c = await company();
  await recipient(c);
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM organizations) AS companies,
    (SELECT count(*) FROM personal_pins) AS pins,(SELECT count(*) FROM audit_logs) AS audits`)
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

test('Swagger exposes member delivery projection and static search remains separate from company IDs', async () => {
  const doc = await (await fetch(base + '/api/docs-json')).json();
  const operation = doc.paths['/api/companies/search'].get;
  assert.deepEqual(operation.tags, ['Companies']);
  assert.deepEqual(operation.security, [{ bearer: [] }]);
  assert.equal(operation.parameters.find((p) => p.name === 'q').schema.maxLength, 100);
  assert.ok(operation.parameters.some((p) => p.name === 'q' && p.required));
  assert.ok(!operation.parameters.some((p) => p.name === 'call_session_seq'));
  assert.deepEqual(
    Object.keys(doc.components.schemas.CompanyDirectoryEnvelopeDto.properties).sort(),
    ['data', 'hasNext', 'total_count'],
  );
  assert.ok(doc.components.schemas.CompanyDirectoryEntryDto.properties.organizationName);
  assert.ok(doc.components.schemas.CompanyDirectoryEntryDto.properties.addressData);
  assert.ok(doc.components.schemas.CompanyDirectoryEntryDto.properties.customerSeq);
  assert.equal(doc.components.schemas.CompanyDirectoryEntryDto.properties.companyPinSeq, undefined);
  assert.equal(
    (await fetch(base + '/api/companies/2147483647', { headers: adminHeaders })).status,
    404,
  );
});

test('request logs contain route templates without query, recipient or phone values', async () => {
  const requestId = randomUUID(),
    term = marker();
  await result(await search({ q: term }, { ...businessHeaders(), 'X-Request-Id': requestId }));
  await new Promise((resolve) => setImmediate(resolve));
  const entries = logs.filter((entry) => entry.requestId === requestId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].route, '/api/companies/search');
  assert.ok(!JSON.stringify(entries).includes(term));
});

const memberSearch = (query, headers = adminHeaders) =>
  fetch(
    base +
      '/api/companies/members/search?' +
      (typeof query === 'string' ? query : new URLSearchParams(query)),
    { headers },
  );

test('administrator member search includes addressless members and searches only member fields', async () => {
  const term = marker(),
    c = await company(marker()),
    employeeNo = '0007-' + term;
  const member = await recipient(c, { name: term + ' 가나', employeeNo, addressData: null });
  const phone = (
    await pool.query('SELECT phone_number FROM customers WHERE customer_seq=$1', [
      member.customerSeq,
    ])
  ).rows[0].phone_number;
  const expected = {
    organizationSeq: c.id,
    organizationName: c.name,
    organizationStatus: 'ACTIVE',
    membershipSeq: member.membershipSeq,
    membershipStatus: 'ACTIVE',
    employeeNo,
    departmentName: '검증 부서',
    name: term + ' 가나',
    phoneNumber: phone,
  };
  for (const q of [
    term,
    employeeNo,
    phone,
    phone.slice(0, 3) + '-' + phone.slice(3, 7) + '-' + phone.slice(7),
    term + ' 부서',
    term + ' ' + '가나'.normalize('NFD'),
  ])
    assert.deepEqual((await result(await memberSearch({ q }))).data, [expected]);
  for (const q of [c.name, term + ' 없는이름', "' OR TRUE --", '---'])
    assert.deepEqual((await result(await memberSearch({ q }))).data, []);
  const addressOnly = marker();
  await pool.query('UPDATE customers SET address_data=$1 WHERE customer_seq=$2', [
    { roadAddress: addressOnly, jibunAddress: '지번', dongName: '동', postalCode: '12345' },
    member.customerSeq,
  ]);
  assert.deepEqual((await result(await memberSearch({ q: addressOnly }))).data, []);
  await pool.query('UPDATE memberships SET department_seq=NULL WHERE membership_seq=$1', [
    member.membershipSeq,
  ]);
  assert.deepEqual((await result(await memberSearch({ q: employeeNo }))).data, [
    { ...expected, departmentName: null },
  ]);
});

test('administrator member search defaults to active and includes inactive only on explicit true', async () => {
  const term = marker(),
    active = await company(),
    inactive = await company(marker(), 'INACTIVE');
  const visible = await recipient(active, { name: term });
  const inactiveMember = await recipient(active, { name: term, membershipStatus: 'INACTIVE' });
  const inactiveCompany = await recipient(inactive, { name: term });
  await recipient(active, { name: term, status: 'WITHDRAWN' });
  const removed = await recipient(active, { name: term });
  await pool.query('UPDATE memberships SET deleted_at=clock_timestamp() WHERE membership_seq=$1', [
    removed.membershipSeq,
  ]);
  const deletedCustomer = await recipient(active, { name: term });
  await pool.query('UPDATE customers SET deleted_at=clock_timestamp() WHERE customer_seq=$1', [
    deletedCustomer.customerSeq,
  ]);
  const deletedCompany = await company();
  await recipient(deletedCompany, { name: term });
  await pool.query(
    'UPDATE organizations SET deleted_at=clock_timestamp() WHERE organization_seq=$1',
    [deletedCompany.id],
  );
  for (const includeInactive of [undefined, 'false']) {
    const query = { q: term, ...(includeInactive === undefined ? {} : { includeInactive }) };
    const body = await result(await memberSearch(query));
    assert.deepEqual(
      body.data.map((row) => row.membershipSeq),
      [visible.membershipSeq],
    );
    assert.equal(body.total_count, 1);
  }
  const body = await result(await memberSearch({ q: term, includeInactive: 'true' }));
  assert.equal(body.total_count, 3);
  assert.deepEqual(
    new Set(body.data.map((row) => row.membershipSeq)),
    new Set([visible.membershipSeq, inactiveMember.membershipSeq, inactiveCompany.membershipSeq]),
  );
  assert.equal(
    body.data.find((row) => row.membershipSeq === inactiveMember.membershipSeq).membershipStatus,
    'INACTIVE',
  );
  assert.equal(
    body.data.find((row) => row.membershipSeq === inactiveCompany.membershipSeq).organizationStatus,
    'INACTIVE',
  );
});

test('administrator search keeps session roles, stable pagination, literal matching and exact counts', async () => {
  const term = marker() + '100%_',
    c = await company();
  const first = await recipient(c, { name: term }),
    second = await recipient(c, { name: term });
  for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
    const body = await result(await memberSearch({ q: term }, await account(role)));
    assert.deepEqual(
      body.data.map((row) => row.membershipSeq),
      [first.membershipSeq, second.membershipSeq],
    );
  }
  for (const headers of [
    {},
    businessHeaders(),
    { Cookie: 'dva_session=bad', ...businessHeaders() },
  ])
    await error(await memberSearch({ q: term }, headers), 401, 'UNAUTHORIZED');
  for (const offset of [0, 1, 99]) {
    const body = await result(await memberSearch({ q: term, limit: '1', offset: String(offset) }));
    assert.equal(body.total_count, 2);
    assert.equal(body.hasNext, offset === 0);
    assert.deepEqual(
      body.data.map((row) => row.membershipSeq),
      offset === 0 ? [first.membershipSeq] : offset === 1 ? [second.membershipSeq] : [],
    );
  }
  const doc = await (await fetch(base + '/api/docs-json')).json();
  assert.deepEqual(doc.paths['/api/companies/members/search'].get.security, [{ adminSession: [] }]);
  assert.equal(
    doc.paths['/api/companies/members/search'].get.parameters.find((p) => p.name === 'q').schema
      .maxLength,
    100,
  );
});

test('both searches enforce normalized 100-code-point bounds and reject invalid or repeated parameters', async () => {
  for (const read of [search, memberSearch]) {
    for (const q of [
      '가'.repeat(100),
      '😀'.repeat(100),
      '  ' + '가'.repeat(100).normalize('NFD') + '  ',
    ])
      await result(await read({ q }));
    for (const q of ['가'.repeat(101), '😀'.repeat(101), '\u0000']) {
      const response = await read({ q });
      await error(response.clone(), 400, 'INVALID_REQUEST');
      assert.ok((await response.json()).error.details.some((detail) => detail.field === 'q'));
    }
  }
  for (const query of [
    '',
    'q=',
    'q=%20',
    'q=a&q=b',
    'q[x]=a',
    'q=a&limit=0',
    'q=a&limit=101',
    'q=a&offset=-1',
    'q=a&includeInactive=1',
    'q=a&includeInactive=',
    'q=a&includeInactive=true&includeInactive=false',
    'q=a&organizationSeq=1',
  ])
    await error(await memberSearch(query), 400, 'INVALID_REQUEST');
});
