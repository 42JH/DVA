const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomInt } = require('node:crypto');
const {
  applicationFixture,
  businessHeaders,
  createTestPool,
} = require('./helpers/application.cjs');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const f = applicationFixture('주문 탭 집계');
const orderIds = [],
  draftIds = [];
after(async () => {
  const pool = createTestPool();
  try {
    // 전체 검증의 후속 운영 이미지 테스트가 이 미래 시각의 부분 스냅샷을 선택하지 않게 한다.
    await pool.query('UPDATE orders SET deleted_at=now() WHERE order_seq=ANY($1::int[])', [
      orderIds,
    ]);
    await pool.query(
      'UPDATE order_parcel_drafts SET deleted_at=now() WHERE draft_seq=ANY($1::int[])',
      [draftIds],
    );
  } finally {
    await pool.end();
  }
});
const empty = { all: 0, incomplete: 0, notPaid: 0, paid: 0, submissionFailed: 0, cancelled: 0 };
const range = { from: '2096-01-01T00:00:00+09:00', to: '2096-01-02T00:00:00+09:00' };
async function json(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
const list = (query = {}, actor = 0, headers = {}) =>
  f.get('/api/admin/orders?' + new URLSearchParams(query), actor, headers);
async function order(marker, status = 'COLLECTING', changes = {}) {
  const id = (
    await f.pool.query(
      `INSERT INTO orders(status,created_at,customer_seq,total_amount,payment_method_type)
     VALUES('COLLECTING','2096-01-01T01:00:00+09:00',$1,1000,'billing') RETURNING order_seq`,
      [changes.customer ?? null],
    )
  ).rows[0].order_seq;
  orderIds.push(id);
  await f.pool.query(
    'INSERT INTO order_parcels(order_seq,parcel_position,origin_name,origin_phone_number,document_count) VALUES($1,1,$2,$3,1)',
    [id, marker, '01012345678'],
  );
  await f.pool.query(
    `UPDATE orders SET status=$2,pickup_requested_at='2096-01-02T00:00:00+09:00',
     parcel_no=CASE WHEN $2='ACCEPTED' THEN 'COUNT001' END,
     dver_received_at=CASE WHEN $2='ACCEPTED' THEN now() END WHERE order_seq=$1`,
    [id, status],
  );
  return id;
}
async function draft(
  marker,
  status = 'INCOMPLETE',
  customer = null,
  createdAt = '2096-01-01T01:00:00+09:00',
) {
  const id = (
    await f.pool.query(
      `INSERT INTO order_parcel_drafts(client_parcel_id,creation_payload,parcel_data,status,customer_seq,created_at,created_by_admin_user_seq,order_seq,order_parcel_seq)
     VALUES($1,'{}',$2,$3,$4,$5,$6,CASE WHEN $3='CONVERTED' THEN 2147483646 END,CASE WHEN $3='CONVERTED' THEN 2147483646 END) RETURNING draft_seq`,
      [
        randomUUID(),
        { origin: { name: marker, phoneNumber: '01012345678', detailAddress: marker } },
        status,
        customer,
        createdAt,
        f.ids[0],
      ],
    )
  ).rows[0].draft_seq;
  draftIds.push(id);
  return id;
}

test('status counts retain payment groups independently of the selected tab and page', async () => {
  const q = randomUUID();
  for (const status of [
    'COLLECTING',
    'notPaid',
    'PAID',
    'SUBMITTING',
    'ACCEPTED',
    'SUBMITTING_FAILED',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ])
    await order(q, status);
  await draft(q);
  for (const status of ['READY', 'EDITING', 'CONVERTED', 'CANCELLED', 'RESUMED'])
    await draft(q, status);
  const expected = {
    all: 9,
    incomplete: 1,
    notPaid: 1,
    paid: 3,
    submissionFailed: 2,
    cancelled: 1,
  };
  for (const statusGroup of [
    undefined,
    'COLLECTING',
    'notPaid',
    'PAID',
    'SUBMISSION_FAILED',
    'CANCELLED',
  ]) {
    const query = { ...range, q, limit: 1, offset: 0, ...(statusGroup ? { statusGroup } : {}) };
    const first = await json(await list(query));
    assert.deepEqual(first.statusCounts, expected);
    assert.equal(first.data.length, 1);
    const outside = await json(await list({ ...query, offset: 100 }));
    assert.deepEqual(outside.statusCounts, expected);
    assert.equal(outside.total_count, first.total_count);
    assert.deepEqual(outside.data, []);
  }
});

test('draft counts and the incomplete list share search, date, current company, deletion and retention filters', async () => {
  const q = randomUUID();
  const company = (
    await f.pool.query(
      "INSERT INTO organizations(name,status) VALUES($1,'INACTIVE') RETURNING organization_seq",
      [q],
    )
  ).rows[0].organization_seq;
  const customer = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES($1,$2,'ACTIVE') RETURNING customer_seq",
      [q, '010' + randomInt(10000000, 100000000)],
    )
  ).rows[0].customer_seq;
  await f.pool.query(
    "INSERT INTO memberships(organization_seq,customer_seq,employee_no,role,status) VALUES($1,$2,'001','MEMBER','INACTIVE')",
    [company, customer],
  );
  await order(q, 'notPaid', { customer });
  const kept = await draft(q, 'INCOMPLETE', customer);
  const deleted = await draft(q, 'INCOMPLETE', customer);
  const expired = await draft(q, 'INCOMPLETE', customer);
  await draft(q, 'INCOMPLETE', null);
  await draft(q, 'INCOMPLETE', customer, range.to);
  await f.pool.query('UPDATE order_parcel_drafts SET deleted_at=now() WHERE draft_seq=$1', [
    deleted,
  ]);
  await f.pool.query(
    "UPDATE order_parcel_drafts SET retention_started_at=now()-interval '6 years' WHERE draft_seq=$1",
    [expired],
  );
  const query = { ...range, q, organizationSeq: company };
  const screen = await json(await list(query));
  assert.deepEqual(screen.statusCounts, { ...empty, all: 2, notPaid: 1, incomplete: 1 });
  const drafts = await json(await f.get('/api/parcel-drafts?' + new URLSearchParams(query)));
  assert.equal(drafts.total_count, screen.statusCounts.incomplete);
  assert.deepEqual(
    drafts.data.map((d) => d.draftSeq),
    [kept],
  );
  const phone = await json(await list({ ...range, q: '010-1234-5678', organizationSeq: company }));
  assert.deepEqual(phone.statusCounts, screen.statusCounts);
  await f.pool.query('UPDATE memberships SET deleted_at=now() WHERE customer_seq=$1', [customer]);
  assert.deepEqual((await json(await list(query))).statusCounts, empty);
});

test('migrated originals, deleted and expired orders do not contribute to actual-order counts', async () => {
  const q = randomUUID();
  const migrated = await order(q);
  const migratedDraft = await draft(q);
  await f.pool.query('UPDATE order_parcel_drafts SET legacy_order_seq=$1 WHERE draft_seq=$2', [
    migrated,
    migratedDraft,
  ]);
  const deleted = await order(q, 'notPaid');
  const expired = await order(q);
  await f.pool.query('UPDATE orders SET deleted_at=now() WHERE order_seq=$1', [deleted]);
  await f.pool.query("UPDATE orders SET created_at=now()-interval '6 years' WHERE order_seq=$1", [
    expired,
  ]);
  const response = await json(await list({ q }));
  assert.deepEqual(response.statusCounts, { ...empty, all: 1, incomplete: 1 });
  assert.equal(response.total_count, 1);
});

test('mixed order and incomplete rows paginate together and use reservation numbers without leaking snapshots', async () => {
  const q = randomUUID();
  const actual = await order(q, 'notPaid');
  const newer = await draft(q, 'INCOMPLETE', null, '2096-01-01T02:00:00+09:00');
  const older = await draft(q, 'INCOMPLETE', null, '2096-01-01T00:30:00+09:00');
  const pages = [];
  for (let offset = 0; offset < 3; offset++) {
    const page = await json(await list({ ...range, q, limit: 1, offset }));
    assert.equal(page.total_count, 3);
    assert.equal(page.hasNext, offset < 2);
    assert.deepEqual(page.statusCounts, { ...empty, all: 3, incomplete: 2, notPaid: 1 });
    pages.push(page.data[0]);
  }
  assert.deepEqual(
    pages.map((r) => r.draftSeq),
    [newer, null, older],
  );
  assert.equal(pages[1].orderSeq, actual);
  const detail = await json(await f.get('/api/parcel-drafts/' + newer));
  assert.equal(pages[0].orderSeq, detail.data.reservedOrderSeq);
  assert.equal(pages[0].status, 'COLLECTING');
  assert.equal(pages[0].parcels[0].orderParcelSeq, null);
  assert.equal(pages[0].parcels[0].origin.name, q);
  assert.equal(pages[0]._draftParcel, undefined);
  const incomplete = await json(await list({ ...range, q, statusGroup: 'COLLECTING' }));
  assert.equal(incomplete.total_count, 2);
  assert.deepEqual(
    incomplete.data.map((r) => r.draftSeq),
    [newer, older],
  );
  const before = await json(await list({ ...range, q, to: '2096-01-01T01:00:00+09:00' }));
  assert.equal(before.total_count, 1);
  assert.equal(before.data[0].draftSeq, older);
});

test('page and counts use the same snapshot when another connection inserts after the page query', async () => {
  const q = randomUUID();
  await order(q, 'notPaid');
  const repository = f.app.get(OrdersRepository);
  const original = repository.adminList;
  repository.adminList = async function (client, query) {
    const result = await original.call(this, client, query);
    if (query.q === q) await order(q, 'notPaid');
    return result;
  };
  try {
    const response = await json(await list({ q }));
    assert.equal(response.total_count, 1);
    assert.equal(response.statusCounts.all, 1);
    assert.equal(response.statusCounts.notPaid, 1);
  } finally {
    repository.adminList = original;
  }
  assert.equal((await json(await list({ q }))).statusCounts.all, 2);
});

test('empty scopes, administrator roles, AI denial, new draft filter validation and Swagger are explicit', async () => {
  for (let actor = 0; actor < 3; actor++)
    assert.deepEqual((await json(await list({ q: randomUUID() }, actor))).statusCounts, empty);
  await f.error(
    await list({}, 0, { Cookie: undefined, ...businessHeaders() }),
    401,
    'UNAUTHORIZED',
  );
  for (const query of [
    { organizationSeq: 0 },
    { from: '2096-01-02T00:00:00Z', to: '2096-01-01T00:00:00Z' },
    { from: '2096-01-01' },
  ])
    await f.error(
      await f.get('/api/parcel-drafts?' + new URLSearchParams(query)),
      400,
      'INVALID_REQUEST',
    );
});
