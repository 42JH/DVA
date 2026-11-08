const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { createTestPool } = require('./helpers/application.cjs');
const { migrate } = require('./helpers/migrations.cjs');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const { AdminOrderListQueryDto } = require('../dist/orders/dto/admin-order-list.dto');
const pool = createTestPool();
const repository = new OrdersRepository();
const baseline = readFileSync(join(__dirname, 'fixtures/admin-order-list-a7988bf9.sql'), 'utf8');
let ids = [],
  company,
  customer,
  draft;
before(async () => {
  await migrate(pool);
  company = (
    await pool.query(
      "INSERT INTO organizations(name,status) VALUES($1,'INACTIVE') RETURNING organization_seq",
      [randomUUID()],
    )
  ).rows[0].organization_seq;
  customer = (
    await pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('최적화 고객',$1,'ACTIVE') RETURNING customer_seq",
      ['010' + randomInt(10000000, 100000000)],
    )
  ).rows[0].customer_seq;
  await pool.query(
    "INSERT INTO memberships(customer_seq,organization_seq,employee_no,role,status) VALUES($1,$2,'001','MEMBER','INACTIVE')",
    [customer, company],
  );
  ids = (
    await pool.query(
      `INSERT INTO orders(status,payment_method_type,customer_seq,created_at,pickup_requested_at)
   SELECT 'COLLECTING','billing',CASE WHEN n%5=0 THEN $1::int END,
    '2094-01-01'::timestamptz + (n/2)*interval '1 second','2094-01-02'
   FROM generate_series(1,2000) n RETURNING order_seq`,
      [customer],
    )
  ).rows.map((r) => r.order_seq);
  await pool.query(
    `INSERT INTO order_parcels(order_seq,parcel_position,status,origin_name,origin_phone_number,origin_road_address,origin_detail_address,destination_name,document_count)
   SELECT id,n,'ACTIVE',
    CASE WHEN n=1 THEN '한글 검색_%' ELSE '발송인' END,'01012345678','수원로 10',CASE WHEN n%2=0 THEN '101호' END,'수령인',1
   FROM unnest($1::int[]) id CROSS JOIN generate_series(1,6) n`,
    [ids],
  );
  await pool.query(
    "UPDATE order_parcels SET status='CANCELLED' WHERE order_seq=ANY($1::int[]) AND parcel_position=6",
    [ids],
  );
  await pool.query(
    `UPDATE orders o SET status=(ARRAY['COLLECTING','notPaid','PAID','SUBMITTING_FAILED','SUBMISSION_FAILED','CANCELLED'])[(n%6+1)::int]
   FROM unnest($1::int[]) WITH ORDINALITY t(id,n) WHERE o.order_seq=t.id`,
    [ids],
  );
  await pool.query('UPDATE orders SET deleted_at=now() WHERE order_seq=$1', [ids[0]]);
  await pool.query("UPDATE orders SET created_at='2000-01-01' WHERE order_seq=$1", [ids[1]]);
  draft = (
    await pool.query(
      `INSERT INTO order_parcel_drafts(client_parcel_id,creation_payload,parcel_data,status,legacy_order_seq)
   VALUES($1,'{}','{}','INCOMPLETE',$2) RETURNING draft_seq`,
      [randomUUID(), ids[2]],
    )
  ).rows[0].draft_seq;
  await pool.query('ANALYZE orders');
  await pool.query('ANALYZE order_parcels');
});
after(async () => {
  try {
    await pool.query('UPDATE orders SET deleted_at=now() WHERE order_seq=ANY($1::int[])', [ids]);
    if (draft)
      await pool.query('UPDATE order_parcel_drafts SET deleted_at=now() WHERE draft_seq=$1', [
        draft,
      ]);
    if (company)
      await pool.query('UPDATE organizations SET deleted_at=now() WHERE organization_seq=$1', [
        company,
      ]);
    if (customer)
      await pool.query('UPDATE customers SET deleted_at=now() WHERE customer_seq=$1', [customer]);
  } finally {
    await pool.end();
  }
});
const query = (changes = {}) =>
  Object.assign(new AdminOrderListQueryDto(), {
    from: '2094-01-01T00:00:00Z',
    to: '2094-01-02T00:00:00Z',
    ...changes,
  });
async function capture(input) {
  let statement;
  await repository.adminList(
    {
      query: async (sql, values) => {
        statement = { sql, values };
        return { rows: [{ __total_count: '0', __page_ordinal: null }] };
      },
    },
    input,
  );
  return statement;
}
async function oldPage(client, input) {
  const phone = input.q && /^[0-9+() -]+$/.test(input.q) ? input.q.replace(/[^0-9]/g, '') : null;
  const result = await client.query(baseline, [
    input.q || null,
    input.from ?? null,
    input.to ?? null,
    input.statusGroup ?? null,
    phone || null,
    input.organizationSeq ?? null,
    input.limit + 1,
    input.offset,
  ]);
  return {
    total_count: Number(result.rows[0].__total_count),
    rows: result.rows
      .filter((r) => r.__page_ordinal !== null)
      .map(({ __page_ordinal, __total_count, ...row }) => row),
  };
}
test('optimized order pages equal the original SQL for every field, filter, grouping and page boundary', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const cases = [
      {},
      { offset: 950 },
      { offset: 1900 },
      { offset: 5000 },
      { offset: Number.MAX_SAFE_INTEGER },
      { limit: 1 },
      { limit: 100 },
      { q: '한글' },
      { q: '_%' },
      { q: '010-1234-5678' },
      { q: '존재하지않는검색' },
      { q: '101호', organizationSeq: company },
      { organizationSeq: company },
      { organizationSeq: 2147483647 },
      { from: '2094-01-01T00:05:00Z', to: '2094-01-01T00:10:00Z' },
      ...['COLLECTING', 'notPaid', 'PAID', 'SUBMISSION_FAILED', 'CANCELLED'].map((statusGroup) => ({
        statusGroup,
        offset: 20,
      })),
    ];
    for (const changes of cases) {
      const input = query(changes);
      assert.deepEqual(
        await repository.adminList(client, input),
        await oldPage(client, input),
        JSON.stringify(changes),
      );
    }
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
function aggregates(plan) {
  const nodes = [];
  const visit = (node) => {
    if (node['Node Type'] === 'Aggregate' && node['Parent Relationship'] === 'SubPlan')
      nodes.push(node['Actual Loops']);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(plan);
  return nodes;
}
test('order-page work and alternating query timings are measured on the same snapshot', async (t) => {
  const client = await pool.connect();
  const input = query({ offset: 1900 });
  const current = await capture(input);
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const plans = [];
    for (const sql of [baseline, current.sql])
      plans.push(
        (await client.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql, current.values))
          .rows[0]['QUERY PLAN'][0],
      );
    assert.ok(aggregates(plans[0].Plan).some((loops) => loops > input.limit + 1));
    assert.ok(aggregates(plans[1].Plan).every((loops) => loops <= input.limit + 1));
    const timings = [[], []];
    for (let round = 0; round < 10; round++)
      for (const i of round % 2 ? [1, 0] : [0, 1]) {
        const start = performance.now();
        await client.query(i === 0 ? baseline : current.sql, current.values);
        timings[i].push(performance.now() - start);
      }
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    t.diagnostic(
      JSON.stringify({
        orders: ids.length,
        parcelsPerOrder: 6,
        limit: input.limit,
        offset: input.offset,
        baseline: {
          jsonAggregateLoops: aggregates(plans[0].Plan),
          executionMs: plans[0]['Execution Time'],
          medianMs: median(timings[0]),
        },
        current: {
          jsonAggregateLoops: aggregates(plans[1].Plan),
          executionMs: plans[1]['Execution Time'],
          medianMs: median(timings[1]),
        },
      }),
    );
    await client.query('COMMIT');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
