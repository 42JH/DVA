require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const f = applicationFixture();

async function customer() {
  return (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE') RETURNING customer_seq AS id,name,phone_number AS phone",
      ['소속고객' + randomUUID(), '010' + randomInt(10000000, 100000000)],
    )
  ).rows[0];
}
async function company(status = 'ACTIVE') {
  return (
    await f.pool.query(
      'INSERT INTO organizations(name,status) VALUES($1,$2) RETURNING organization_seq AS id,name',
      ['기업' + randomUUID(), status],
    )
  ).rows[0];
}
async function membership(c, o, status = 'ACTIVE') {
  return (
    await f.pool.query(
      "INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES($1,$2,$3,'MEMBER',$4) RETURNING membership_seq AS id",
      [c.id, o.id, randomUUID(), status],
    )
  ).rows[0];
}
async function order(c = null) {
  return (
    await f.pool.query('INSERT INTO orders(customer_seq) VALUES($1) RETURNING order_seq AS id', [
      c?.id ?? null,
    ])
  ).rows[0];
}
async function call(c = null, linkedOrder = null) {
  const phone = c?.phone ?? '010' + randomInt(10000000, 100000000);
  return (
    await f.pool.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,customer_seq,order_seq,incoming_at,started_at,ended_at)
       VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()-interval '2 minutes',clock_timestamp())
       RETURNING call_session_seq AS id,caller_phone_number AS phone`,
      ['rtc_company_' + randomUUID(), phone, c?.id ?? null, linkedOrder?.id ?? null],
    )
  ).rows[0];
}
async function body(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
const calls = (c, query = {}) =>
  f.get('/api/calls?' + new URLSearchParams({ callerPhoneNumber: c.phone, ...query }));
async function callIdentity(c, customerSeq, organizationName) {
  const list = await body(await calls(c));
  assert.equal(list.total_count, 1);
  assert.equal(list.data.length, 1);
  const detail = (await body(await f.get('/api/calls/' + c.id))).data.call;
  for (const row of [list.data[0], detail]) {
    assert.equal(row.customerSeq, customerSeq);
    assert.equal(row.organizationName, organizationName);
    assert.equal(row.analysisStatus, 'PENDING');
    assert.equal(row.recordedAt, null);
    for (const key of ['customerCategory', 'customerType'])
      assert.equal(Object.hasOwn(row, key), false);
  }
}

test('call list and detail distinguish a company, a personal customer and an unknown caller without a new category field', async () => {
  const c = await customer(),
    o = await company();
  await membership(c, o);
  await callIdentity(await call(c), c.id, o.name);
  const personal = await customer();
  await callIdentity(await call(personal), personal.id, null);
  await callIdentity(await call(), null, null);
});

test('call organization uses the same order-first customer as the existing response and falls back after order deletion', async () => {
  const caller = await customer(),
    buyer = await customer(),
    callerCompany = await company(),
    buyerCompany = await company();
  await membership(caller, callerCompany);
  await membership(buyer, buyerCompany);
  const purchase = await order(buyer);
  const c = await call(caller, purchase);
  await callIdentity(c, buyer.id, buyerCompany.name);
  await f.pool.query('UPDATE orders SET deleted_at=clock_timestamp() WHERE order_seq=$1', [
    purchase.id,
  ]);
  await callIdentity(c, caller.id, callerCompany.name);
});

test('inactive companies and memberships remain visible while deleted customer, membership or company only hides its projection', async () => {
  for (const companyStatus of ['ACTIVE', 'INACTIVE'])
    for (const memberStatus of ['ACTIVE', 'INACTIVE']) {
      const c = await customer(),
        o = await company(companyStatus);
      await membership(c, o, memberStatus);
      await callIdentity(await call(c), c.id, o.name);
    }
  for (const deleted of ['customers', 'memberships', 'organizations']) {
    const c = await customer(),
      o = await company(),
      m = await membership(c, o),
      phone = await call(c);
    const [key, id] =
      deleted === 'customers'
        ? ['customer_seq', c.id]
        : deleted === 'memberships'
          ? ['membership_seq', m.id]
          : ['organization_seq', o.id];
    await f.pool.query(`UPDATE ${deleted} SET deleted_at=clock_timestamp() WHERE ${key}=$1`, [id]);
    await callIdentity(phone, deleted === 'customers' ? null : c.id, null);
    assert.equal((await body(await calls(phone, { organizationSeq: o.id }))).total_count, 0);
  }
});

test('current company rename and membership replacement preserve call pagination and exact organization filters', async () => {
  const c = await customer(),
    oldCompany = await company(),
    nextCompany = await company(),
    m = await membership(c, oldCompany),
    first = await call(c);
  const renamed = '새기업명' + randomUUID();
  await f.pool.query('UPDATE organizations SET name=$2 WHERE organization_seq=$1', [
    oldCompany.id,
    renamed,
  ]);
  await callIdentity(first, c.id, renamed);
  await f.pool.query(
    'UPDATE memberships SET deleted_at=clock_timestamp() WHERE membership_seq=$1',
    [m.id],
  );
  await membership(c, nextCompany);
  await callIdentity(first, c.id, nextCompany.name);
  await call(c);
  await call(c);
  const all = await body(
    await calls(first, { organizationSeq: nextCompany.id, q: c.name, limit: 1, offset: 1 }),
  );
  assert.equal(all.total_count, 3);
  assert.equal(all.data.length, 1);
  assert.equal(all.hasNext, true);
  assert.equal(all.data[0].organizationName, nextCompany.name);
  for (const organizationSeq of [oldCompany.id, 2147483647]) {
    const empty = await body(await calls(first, { organizationSeq }));
    assert.deepEqual(empty, { data: [], hasNext: false, total_count: 0 });
  }
});

test('call company filtering stays admin-only, validates bounded IDs and documents the nullable current name', async () => {
  for (const query of [
    'organizationSeq=0',
    'organizationSeq=-1',
    'organizationSeq=1.5',
    'organizationSeq=1e2',
    'organizationSeq=',
    'organizationSeq=2147483648',
    'organizationSeq=1&organizationSeq=2',
    'organizationSeq=1%20OR%201=1',
  ])
    await f.error(await f.get('/api/calls?' + query), 400, 'INVALID_REQUEST');
  await f.error(
    await f.get('/api/calls?organizationSeq=1', 0, { Cookie: undefined, ...businessHeaders() }),
    401,
    'UNAUTHORIZED',
  );
  for (const actor of [0, 1, 2])
    assert.equal((await f.get('/api/calls?organizationSeq=2147483647', actor)).status, 200);
  const spec = await body(await f.get('/api/docs-json'));
  assert.equal(spec.components.schemas.CallDto.properties.organizationName.nullable, true);
  const parameter = spec.paths['/api/calls'].get.parameters.find(
    (p) => p.name === 'organizationSeq',
  );
  assert.equal(parameter.schema.minimum, 1);
  assert.equal(parameter.schema.maximum, 2147483647);
  for (const key of ['customerCategory', 'customerType'])
    assert.equal(spec.components.schemas.CallDto.properties[key], undefined);
});
