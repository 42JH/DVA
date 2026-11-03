const { testMembership } = require('./helpers/membership.cjs');
require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { migrate } = require('./helpers/migrations.cjs');
const { createTestPool, startTestApp } = require('./helpers/application.cjs');

assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
process.env.SWAGGER_ENABLED = 'true';
process.env.CORS_ORIGINS = 'http://localhost:5173';
const { DatabaseService } = require('../dist/database/database.service');
const pool = createTestPool();
const apps = [];
let app, base;
const logs = [];
const phone = () => '010' + String(randomInt(10000000, 100000000));
const address = {
  name: '주소 수령인',
  phoneNumber: '01000000001',
  roadAddress: '예시로 12',
  jibunAddress: '예시동 12',
  detailAddress: '101호',
  dongName: '예시동',
  postalCode: '01234',
};
before(async () => {
  await migrate(pool);
  app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
  base = await app.getUrl();
});
after(async () => {
  for (const application of apps) await application.close();
  await pool.end();
});
async function customer(status = 'ACTIVE') {
  const { rows } = await pool.query(
    `INSERT INTO customers(name,phone_number,status) VALUES('초기 조회 고객',$1,$2)
     RETURNING customer_seq AS "customerSeq",name,phone_number AS "phoneNumber",status,
       monthly_billing_enabled AS "monthlyBillingEnabled", address_data AS address`,
    [phone(), status],
  );
  return rows[0];
}
async function organization(status = 'ACTIVE') {
  return (
    await pool.query(
      `INSERT INTO organizations(name,status) VALUES('초기 조회 기업',$1) RETURNING organization_seq`,
      [status],
    )
  ).rows[0].organization_seq;
}
async function member(customerSeq, organizationSeq, status = 'ACTIVE', role = 'MEMBER') {
  return (
    await testMembership(pool, {
      customerSeq,
      organizationSeq,
      employeeNo: '00' + randomUUID(),
      role,
      status,
    })
  ).rows[0].membership_seq;
}
async function pin(scope, owner, label = null, version = 1) {
  if (scope === 'PERSONAL')
    return (
      await pool.query(
        `INSERT INTO personal_pins(customer_seq,label,address_data,version) VALUES($1,$2,$3,$4)
         RETURNING personal_pin_seq`,
        [owner, label, { ...address, detailAddress: randomUUID() }, version],
      )
    ).rows[0].personal_pin_seq;
  return (
    await pool.query(
      `INSERT INTO company_pins(organization_seq,label,department_name,address_data,version)
       VALUES($1,$2,'개발부',$3,$4) RETURNING company_pin_seq`,
      [owner, label, { ...address, detailAddress: randomUUID() }, version],
    )
  ).rows[0].company_pin_seq;
}
function request(input, headers = {}) {
  return fetch(base + '/api/customers/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(input),
  });
}
async function context(number, headers) {
  const response = await request({ phoneNumber: number }, headers);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.equal(body.meta.requestId, response.headers.get('x-request-id'));
  return body.data;
}
const emptyContext = (lookupStatus) => ({
  lookupStatus,
  customer: null,
  membership: null,
  organization: null,
  department: null,
  availableUsageTypes: [],
  availablePaymentMethods: [],
  personalPins: [],
  companyPins: [],
});

test('unknown caller is explicitly unregistered; reads do not create a customer or call', async () => {
  const number = phone();
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM customers) AS customers,
        (SELECT count(*) FROM call_sessions) AS calls, (SELECT count(*) FROM orders) AS orders,
        (SELECT count(*) FROM audit_logs) AS audits`)
    ).rows[0];
  const previous = await counts();
  for (let i = 0; i < 3; i++) assert.deepEqual(await context(number), emptyContext('UNREGISTERED'));
  assert.deepEqual(await counts(), previous);
});

test('two-stage context reads without writes and registers one confirmed orderless call with original identity', async () => {
  const c = await customer();
  const counts = async () =>
    (
      await pool.query(`SELECT (SELECT count(*) FROM customers) AS customers,
        (SELECT count(*) FROM call_sessions) AS calls, (SELECT count(*) FROM orders) AS orders,
        (SELECT count(*) FROM audit_logs) AS audits,
        (SELECT count(*) FROM empty_ai_order_results) AS empty_results`)
    ).rows[0];
  const before = await counts();
  for (let index = 0; index < 2; index++) {
    const initial = await context(c.phoneNumber);
    assert.equal(initial.customer.customerSeq, c.customerSeq);
    assert.equal(Object.hasOwn(initial, 'callSessionSeq'), false);
  }
  assert.deepEqual(await counts(), before);
  const call = { providerCallId: 'confirmed-' + randomUUID(), incomingAt: '2026-10-27T01:00:02Z' };
  const response = await request({ phoneNumber: c.phoneNumber, call });
  assert.equal(response.status, 200);
  const id = (await response.json()).data.callSessionSeq;
  assert.ok(Number.isInteger(id));
  const saved = (
    await pool.query(
      'SELECT provider_call_id,incoming_at,caller_phone_number,customer_seq,order_seq FROM call_sessions WHERE call_session_seq=$1',
      [id],
    )
  ).rows[0];
  assert.equal(saved.provider_call_id, call.providerCallId);
  assert.equal(saved.incoming_at.toISOString(), '2026-10-27T01:00:02.000Z');
  assert.equal(saved.caller_phone_number, c.phoneNumber);
  assert.equal(saved.customer_seq, c.customerSeq);
  assert.equal(saved.order_seq, null);
  const expected = {
    ...before,
    calls: String(Number(before.calls) + 1),
    audits: String(Number(before.audits) + 1),
  };
  assert.deepEqual(await counts(), expected);
  const replay = await request({ phoneNumber: c.phoneNumber, call });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).data.callSessionSeq, id);
  assert.deepEqual(await counts(), expected);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS count FROM audit_logs WHERE action='CALL_STARTED' AND target_seq=$1",
        [id],
      )
    ).rows[0].count,
    1,
  );
});

test('registered caller without orders, pins or membership remains registered', async () => {
  const c = await customer();
  assert.deepEqual(await context(c.phoneNumber), {
    ...emptyContext('REGISTERED'),
    customer: c,
    availableUsageTypes: ['PERSONAL'],
    availablePaymentMethods: ['billing'],
  });
});

test('current customer identity and default address remain independent of an older personal PIN', async () => {
  const c = await customer();
  const personal = await pin('PERSONAL', c.customerSeq, '이전 보내는 곳');
  const { name, phoneNumber, ...ownAddress } = address;
  await pool.query('UPDATE customers SET name=$1,address_data=$2 WHERE customer_seq=$3', [
    '현재 고객명',
    { ...ownAddress, detailAddress: '새 상세주소' },
    c.customerSeq,
  ]);
  const result = await context(c.phoneNumber);
  assert.equal(result.customer.name, '현재 고객명');
  assert.equal(result.customer.phoneNumber, c.phoneNumber);
  assert.equal(result.customer.address.detailAddress, '새 상세주소');
  assert.equal(result.personalPins[0].personalPinSeq, personal);
  assert.equal(result.personalPins[0].addressData.name, name);
  assert.equal(result.personalPins[0].addressData.phoneNumber, phoneNumber);
  assert.deepEqual(result.companyPins, []);
});

test('active company member receives personal pins while legacy company pins stay retired', async () => {
  const c = await customer();
  const colleague = await customer();
  const outsider = await customer();
  const org = await organization();
  const otherOrg = await organization();
  const membershipSeq = await member(c.customerSeq, org);
  await member(colleague.customerSeq, org);
  await member(outsider.customerSeq, otherOrg);
  const personal = await pin('PERSONAL', c.customerSeq, '내 주소', 3);
  await pin('COMPANY', org, '기업 공용', 2);
  await pin('PERSONAL', colleague.customerSeq, '동료 비공개');
  await pin('PERSONAL', outsider.customerSeq, '타인 비공개');
  await pin('COMPANY', otherOrg, '다른 기업 공용');
  const result = await context(c.phoneNumber);
  assert.equal(result.lookupStatus, 'REGISTERED');
  assert.deepEqual(result.customer, c);
  assert.equal(result.membership.membershipSeq, membershipSeq);
  assert.equal(result.membership.role, 'MEMBER');
  assert.equal(result.organization.organizationSeq, org);
  assert.deepEqual(result.availableUsageTypes, ['PERSONAL', 'COMPANY']);
  assert.deepEqual(
    result.personalPins.map((p) => p.personalPinSeq),
    [personal],
  );
  assert.deepEqual(
    result.companyPins.map((p) => p.companyPinSeq),
    [],
  );
  assert.equal(result.personalPins[0].version, 3);
  assert.equal(result.personalPins[0].addressData.postalCode, '01234');
  assert.equal(Object.hasOwn(result.personalPins[0].addressData, 'latitude'), false);
  assert.equal(Object.hasOwn(result.personalPins[0].addressData, 'longitude'), false);
  assert.deepEqual(Object.keys(result.personalPins[0]).sort(), [
    'addressData',
    'label',
    'personalPinSeq',
    'version',
  ]);
  const serialized = JSON.stringify(result);
  for (const forbidden of [
    '동료 비공개',
    '타인 비공개',
    '다른 기업 공용',
    'searchText',
    'directory',
  ])
    assert.ok(!serialized.includes(forbidden));
});

test('all membership/company status combinations enforce company access; representative has the same scope', async () => {
  for (const membershipStatus of ['ACTIVE', 'INACTIVE']) {
    for (const companyStatus of ['ACTIVE', 'INACTIVE']) {
      for (const role of ['MEMBER', 'ORG_ADMIN']) {
        const c = await customer();
        const org = await organization(companyStatus);
        await member(c.customerSeq, org, membershipStatus, role);
        const personal = await pin('PERSONAL', c.customerSeq);
        await pin('COMPANY', org);
        const result = await context(c.phoneNumber);
        const canUseCompany = membershipStatus === 'ACTIVE' && companyStatus === 'ACTIVE';
        assert.equal(result.membership.status, membershipStatus);
        assert.equal(result.membership.role, role);
        assert.equal(result.organization.status, companyStatus);
        assert.deepEqual(
          result.personalPins.map((p) => p.personalPinSeq),
          [personal],
        );
        assert.deepEqual(
          result.companyPins.map((p) => p.companyPinSeq),
          [],
        );
        assert.deepEqual(
          result.availableUsageTypes,
          canUseCompany ? ['PERSONAL', 'COMPANY'] : ['PERSONAL'],
        );
      }
    }
  }
});

test('withdrawn callers remain distinct but expose no profile, membership or pins', async () => {
  const c = await customer('WITHDRAWN');
  const org = await organization();
  await member(c.customerSeq, org, 'ACTIVE', 'ORG_ADMIN');
  await pin('PERSONAL', c.customerSeq);
  await pin('COMPANY', org);
  assert.deepEqual(await context(c.phoneNumber), emptyContext('WITHDRAWN'));
  assert.equal(
    (await pool.query('SELECT status FROM customers WHERE customer_seq=$1', [c.customerSeq]))
      .rows[0].status,
    'WITHDRAWN',
  );
});

test('whole address book is returned beyond page size, with stable IDs, nullable labels and address values', async () => {
  const c = await customer();
  const org = await organization();
  await member(c.customerSeq, org);
  const personalIds = [],
    companyIds = [];
  for (let i = 0; i < 105; i++) {
    personalIds.push(await pin('PERSONAL', c.customerSeq));
    companyIds.push(await pin('COMPANY', org));
  }
  const first = await context(c.phoneNumber);
  assert.deepEqual(
    first.personalPins.map((p) => p.personalPinSeq),
    personalIds,
  );
  assert.deepEqual(
    first.companyPins.map((p) => p.companyPinSeq),
    [],
  );
  assert.equal(first.personalPins[0].label, null);
  assert.deepEqual(await context(c.phoneNumber), first);
  const stored = (
    await pool.query('SELECT address_data FROM personal_pins WHERE personal_pin_seq=$1', [
      personalIds[0],
    ])
  ).rows[0].address_data;
  assert.deepEqual(first.personalPins[0].addressData, stored);
});

test('next lookup reflects withdrawal, membership deactivation, unlinking and organization changes', async () => {
  const c = await customer();
  const org = await organization();
  const id = await member(c.customerSeq, org);
  await pin('COMPANY', org);
  assert.equal((await context(c.phoneNumber)).companyPins.length, 0);
  await pool.query("UPDATE memberships SET status='INACTIVE' WHERE membership_seq=$1", [id]);
  assert.deepEqual((await context(c.phoneNumber)).companyPins, []);
  await pool.query("UPDATE memberships SET status='ACTIVE' WHERE membership_seq=$1", [id]);
  await pool.query("UPDATE organizations SET status='INACTIVE' WHERE organization_seq=$1", [org]);
  assert.deepEqual((await context(c.phoneNumber)).companyPins, []);
  await pool.query('DELETE FROM memberships WHERE membership_seq=$1', [id]);
  const unlinked = await context(c.phoneNumber);
  assert.equal(unlinked.membership, null);
  assert.equal(unlinked.organization, null);
  assert.deepEqual(unlinked.availableUsageTypes, ['PERSONAL']);
  await pool.query("UPDATE customers SET status='WITHDRAWN' WHERE customer_seq=$1", [
    c.customerSeq,
  ]);
  assert.deepEqual(await context(c.phoneNumber), emptyContext('WITHDRAWN'));
});

test('only a digits-only string phoneNumber is accepted, without legacy or ownership override fields', async () => {
  for (const input of [
    {},
    { phone: phone() },
    { phoneNumber: null },
    { phoneNumber: 1012345678 },
    { phoneNumber: '' },
    { phoneNumber: '010-1234-5678' },
    { phoneNumber: '+821012345678' },
    { phoneNumber: ' 01012345678' },
    { phoneNumber: '01012345678\n' },
    { phoneNumber: "' OR TRUE --" },
    { phoneNumber: phone(), customerSeq: 1 },
    { phoneNumber: phone(), organizationSeq: 1 },
  ]) {
    const response = await request(input);
    assert.equal(response.status, 400, JSON.stringify(input));
    const body = await response.json();
    assert.equal(body.error.code, 'INVALID_REQUEST');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

test('query failure is 503 rather than a new customer or a partial success', async () => {
  const database = app.get(DatabaseService);
  const original = database.pool.query;
  database.pool.query = async () => {
    throw new Error('private SQL and phoneNumber must not leak');
  };
  try {
    const response = await request({ phoneNumber: phone() });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(body.data, undefined);
    assert.ok(!JSON.stringify(body).includes('private SQL'));
  } finally {
    database.pool.query = original;
  }
});

test('MVP needs no service token or Origin; stale administrator cookies never bypass session checks', async () => {
  const c = await customer();
  assert.equal((await context(c.phoneNumber)).customer.customerSeq, c.customerSeq);
  const badCookie = await request(
    { phoneNumber: c.phoneNumber },
    {
      Cookie: 'dva_session=' + 'f'.repeat(64),
      Origin: 'http://localhost:5173',
    },
  );
  assert.equal(badCookie.status, 401);
  assert.equal((await badCookie.json()).error.code, 'UNAUTHORIZED');
  const administratorList = await fetch(base + '/api/customers');
  assert.equal(administratorList.status, 401);
  const forbidden = await request(
    { phoneNumber: c.phoneNumber },
    { Origin: 'https://untrusted.invalid' },
  );
  assert.equal(forbidden.status, 403);
});

test('request logs contain route and request ID without caller number or address content', async () => {
  const c = await customer();
  const requestId = randomUUID();
  await context(c.phoneNumber, { 'X-Request-Id': requestId });
  await new Promise((resolve) => setImmediate(resolve));
  const entries = logs.filter((entry) => entry.requestId === requestId);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].route, '/api/customers/context');
  assert.ok(!JSON.stringify(entries).includes(c.phoneNumber));
  assert.ok(!JSON.stringify(entries).includes(address.roadAddress));
});
