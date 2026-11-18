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

async function screenOrder(c = null, marker = randomUUID()) {
  const purchase = await order(c);
  await f.pool.query(
    'INSERT INTO order_parcels(order_seq,parcel_position,origin_name,origin_phone_number,document_count) VALUES($1,1,$2,$3,1)',
    [purchase.id, marker, c?.phone ?? null],
  );
  return { ...purchase, marker };
}
const screen = (query = {}, actor = 0, headers = {}) =>
  f.get('/api/admin/orders?' + new URLSearchParams(query), actor, headers);
async function screenIdentity(purchase, customerSeq, organizationName) {
  const list = await body(await screen({ q: purchase.marker }));
  assert.equal(list.total_count, 1);
  assert.equal(list.data.length, 1);
  assert.equal(list.hasNext, false);
  const row = list.data[0];
  assert.equal(row.orderSeq, purchase.id);
  assert.equal(row.customerSeq, customerSeq);
  assert.equal(row.organizationName, organizationName);
  assert.equal(row.parcels.length, 1);
  assert.equal(row.parcels[0].origin.name, purchase.marker);
  for (const key of ['customerCategory', 'customerType'])
    assert.equal(Object.hasOwn(row, key), false);
}

test('admin orders distinguish company, personal and unknown customers even when a company member uses personal card payment', async () => {
  const c = await customer(),
    o = await company();
  await membership(c, o);
  const purchase = await screenOrder(c);
  await f.pool.query("UPDATE orders SET payment_method_type='billing' WHERE order_seq=$1", [
    purchase.id,
  ]);
  await screenIdentity(purchase, c.id, o.name);
  const personal = await customer();
  await screenIdentity(await screenOrder(personal), personal.id, null);
  await screenIdentity(await screenOrder(), null, null);
});

test('admin order organization projection includes inactive memberships and preserves rows after master data soft deletion', async () => {
  for (const companyStatus of ['ACTIVE', 'INACTIVE'])
    for (const memberStatus of ['ACTIVE', 'INACTIVE']) {
      const c = await customer(),
        o = await company(companyStatus);
      await membership(c, o, memberStatus);
      await screenIdentity(await screenOrder(c), c.id, o.name);
    }
  for (const deleted of ['customers', 'memberships', 'organizations']) {
    const c = await customer(),
      o = await company(),
      m = await membership(c, o),
      purchase = await screenOrder(c);
    const [key, id] =
      deleted === 'customers'
        ? ['customer_seq', c.id]
        : deleted === 'memberships'
          ? ['membership_seq', m.id]
          : ['organization_seq', o.id];
    await f.pool.query(`UPDATE ${deleted} SET deleted_at=clock_timestamp() WHERE ${key}=$1`, [id]);
    await screenIdentity(purchase, deleted === 'customers' ? null : c.id, null);
    assert.equal(
      (await body(await screen({ q: purchase.marker, organizationSeq: o.id }))).total_count,
      0,
    );
  }
});

test('admin order company changes use current membership with matching filter, pagination and tab totals', async () => {
  const c = await customer(),
    oldCompany = await company(),
    nextCompany = await company(),
    m = await membership(c, oldCompany),
    first = await screenOrder(c);
  const renamed = '주문현재기업' + randomUUID();
  await f.pool.query('UPDATE organizations SET name=$2 WHERE organization_seq=$1', [
    oldCompany.id,
    renamed,
  ]);
  await screenIdentity(first, c.id, renamed);
  await f.pool.query(
    'UPDATE memberships SET deleted_at=clock_timestamp() WHERE membership_seq=$1',
    [m.id],
  );
  await membership(c, nextCompany);
  await screenIdentity(first, c.id, nextCompany.name);
  await screenOrder(c, first.marker);
  await screenOrder(c, first.marker);
  const query = {
    q: first.marker,
    organizationSeq: nextCompany.id,
    limit: 1,
    offset: 1,
  };
  const page = await body(await screen(query));
  assert.equal(page.total_count, 3);
  assert.equal(page.hasNext, true);
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].organizationName, nextCompany.name);
  for (const changed of [
    { organizationSeq: oldCompany.id },
    { organizationSeq: 2147483647 },
    { statusGroup: 'PAID' },
  ])
    assert.deepEqual(await body(await screen({ ...query, ...changed })), {
      data: [],
      hasNext: false,
      total_count: 0,
      statusCounts: {
        all: changed.statusGroup ? 3 : 0,
        incomplete: 0,
        notPaid: 0,
        paid: 0,
        accepted: 0,
        submissionFailed: 0,
        cancelled: 0,
      },
    });
});

test('admin organization reads preserve business rows and existing AI order list/detail fields and caller scope', async () => {
  const c = await customer(),
    o = await company();
  await membership(c, o);
  const purchase = await screenOrder(c),
    other = await screenOrder(await customer()),
    ongoing = await call(c);
  await f.pool.query(
    'UPDATE call_sessions SET started_at=NULL,ended_at=NULL WHERE call_session_seq=$1',
    [ongoing.id],
  );
  const snapshot = async () =>
    (
      await f.pool.query('SELECT to_jsonb(o) AS value FROM orders o WHERE order_seq=$1', [
        purchase.id,
      ])
    ).rows[0].value;
  const before = await snapshot();
  await screenIdentity(purchase, c.id, o.name);
  const headers = { Cookie: undefined, ...businessHeaders(), call_session_seq: String(ongoing.id) };
  const list = await body(await f.get('/api/orders?customerSeq=' + c.id, 0, headers));
  assert.equal(list.data.find((row) => row.orderSeq === purchase.id).customerSeq, c.id);
  assert.equal(
    list.data.some((row) => row.orderSeq === other.id),
    false,
  );
  const detail = (await body(await f.get('/api/orders/' + purchase.id, 0, headers))).data;
  assert.equal(detail.customerSeq, c.id);
  for (const row of [list.data.find((row) => row.orderSeq === purchase.id), detail])
    for (const key of ['organizationName', 'customerCategory', 'customerType'])
      assert.equal(Object.hasOwn(row, key), false);
  await f.error(await screen({}, 0, headers), 401, 'UNAUTHORIZED');
  assert.deepEqual(await snapshot(), before);
});
