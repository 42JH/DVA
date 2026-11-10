const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  applicationFixture,
  businessHeaders,
  createTestPool,
} = require('./helpers/application.cjs');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const { DashboardRepository } = require('../dist/dashboard/dashboard.repository');
const f = applicationFixture('홈 QA');
process.env.SWAGGER_ENABLED = 'true';
const draftIds = [],
  callIds = [],
  orderIds = [];
after(async () => {
  const pool = createTestPool();
  try {
    await pool.query(
      'UPDATE order_parcel_drafts SET deleted_at=now() WHERE draft_seq=ANY($1::int[])',
      [draftIds],
    );
    await pool.query(
      'UPDATE call_sessions SET deleted_at=now() WHERE call_session_seq=ANY($1::int[])',
      [callIds],
    );
    await pool.query('UPDATE orders SET deleted_at=now() WHERE order_seq=ANY($1::int[])', [
      orderIds,
    ]);
  } finally {
    await pool.end();
  }
});
async function json(response) {
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return response.json();
}
async function home(actor = 0) {
  const body = await json(await f.get('/api/dashboard/home', actor));
  assert.deepEqual(Object.keys(body).sort(), ['data', 'meta']);
  assert.ok(body.meta.requestId);
  assert.ok(Number.isFinite(Date.parse(body.data.observedAt)));
  return body.data;
}
async function draft(changes = {}) {
  const id = (
    await f.pool.query(
      `INSERT INTO order_parcel_drafts(client_parcel_id,creation_payload,parcel_data,status,created_by_admin_user_seq,created_at,deleted_at,retention_started_at)
     VALUES($1,'{"private":"never expose creation copy"}','{}',$2,$3,'2097-01-01',$4,$5) RETURNING draft_seq`,
      [
        randomUUID(),
        changes.status ?? 'INCOMPLETE',
        f.ids[0],
        changes.deleted ? new Date() : null,
        changes.expired ? '2000-01-01' : new Date(),
      ],
    )
  ).rows[0].draft_seq;
  draftIds.push(id);
  return id;
}
async function compareWithLists(value) {
  const orders = await json(await f.get('/api/admin/orders?limit=11'));
  const drafts = await json(await f.get('/api/parcel-drafts?status=INCOMPLETE&limit=11'));
  const calls = await json(await f.get('/api/calls?limit=11'));
  const questions = await json(await f.get('/api/unanswered-questions?status=OPEN&limit=11'));
  const day = new Date(Date.parse(value.observedAt) + 9 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const from = new Date(day + 'T00:00:00+09:00');
  const range = new URLSearchParams({
    from: from.toISOString(),
    to: new Date(from.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    limit: '1',
  });
  const todayOrders = await json(await f.get('/api/admin/orders?' + range));
  assert.equal(
    value.todayOrderCount,
    todayOrders.statusCounts.all - todayOrders.statusCounts.incomplete,
  );
  assert.equal(value.todayCallCount, (await json(await f.get('/api/calls?' + range))).total_count);
  assert.deepEqual(value.pendingWork, {
    incomplete: drafts.total_count,
    notPaid: orders.statusCounts.notPaid,
    submissionFailed: orders.statusCounts.submissionFailed,
    unansweredQuestions: questions.total_count,
  });
  assert.equal(value.pendingWork.incomplete, orders.statusCounts.incomplete);
  assert.deepEqual(value.incompleteDrafts, drafts.data);
  assert.deepEqual(value.recentCalls, calls.data);
  assert.deepEqual(value.unansweredQuestions, questions.data);
  for (const rows of [value.incompleteDrafts, value.recentCalls, value.unansweredQuestions])
    assert.ok(rows.length <= 11);
  for (const [field, path] of Object.entries({
    stageDropoffs: 'stage-dropoffs',
    registrationTime: 'registration-time',
    complaintCalls: 'complaint-calls',
    responseWait: 'response-wait',
  }))
    assert.deepEqual(
      value.aiPerformance[field],
      (await json(await f.get('/api/dashboard/' + path))).data,
    );
}

test('home agrees with the existing lists and all four statistics, including empty or unmeasured data', async () => {
  await compareWithLists(await home());
});

test('home bounds previews, counts all pending rows and shares deletion, expiry and OPEN/INCOMPLETE rules', async () => {
  const baseline = (await home()).pendingWork;
  const kept = [];
  for (let i = 0; i < 13; i++) {
    kept.push(await draft());
    const call = (
      await f.pool.query(
        `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
       VALUES($1,'2097-01-01','2097-01-01','2097-01-01T00:01:00Z') RETURNING call_session_seq`,
        ['home-' + randomUUID()],
      )
    ).rows[0].call_session_seq;
    callIds.push(call);
    await f.pool.query(
      `INSERT INTO unanswered_questions(event_id,call_session_seq,question_text,occurred_at,payload_hash)
       VALUES($1,$2,'홈 미답변 질문','2097-01-01T00:00:10Z',repeat('a',64))`,
      [randomUUID(), call],
    );
  }
  const deleted = await draft({ deleted: true });
  const expired = await draft({ expired: true });
  const ready = await draft({ status: 'READY' });
  const editing = await draft({ status: 'EDITING' });
  const cancelled = await draft({ status: 'CANCELLED' });
  for (const status of ['notPaid', 'SUBMITTING_FAILED', 'SUBMISSION_FAILED'])
    orderIds.push(
      (
        await f.pool.query(
          "INSERT INTO orders(status,payment_method_type,total_amount) VALUES($1,'billing',1000) RETURNING order_seq",
          [status],
        )
      ).rows[0].order_seq,
    );
  const value = await home();
  assert.deepEqual(value.pendingWork, {
    incomplete: baseline.incomplete + 13,
    notPaid: baseline.notPaid + 1,
    submissionFailed: baseline.submissionFailed + 1,
    unansweredQuestions: baseline.unansweredQuestions + 13,
  });
  assert.equal(value.incompleteDrafts.length, 11);
  assert.equal(value.recentCalls.length, 11);
  assert.equal(value.unansweredQuestions.length, 11);
  for (const row of value.incompleteDrafts) {
    assert.ok(kept.includes(row.draftSeq));
    assert.ok(![deleted, expired, ready, editing, cancelled].includes(row.draftSeq));
    assert.ok(!Object.hasOwn(row, 'creationPayload'));
  }
  await compareWithLists(value);
});

test('home uses one read-only repeatable snapshot across counts, previews and metrics', async () => {
  const baseline = await home();
  const repository = f.app.get(OrdersRepository);
  const original = repository.adminStatusCounts;
  let added;
  let addedOrder;
  repository.adminStatusCounts = async function (client, query) {
    assert.equal(
      (await client.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
      'on',
    );
    assert.equal(
      (await client.query('SHOW transaction_isolation')).rows[0].transaction_isolation,
      'repeatable read',
    );
    const result = await original.call(this, client, query);
    added = await draft();
    addedOrder = (
      await f.pool.query(
        "INSERT INTO orders(status,payment_method_type,total_amount) VALUES('notPaid','billing',1000) RETURNING order_seq",
      )
    ).rows[0].order_seq;
    orderIds.push(addedOrder);
    return result;
  };
  try {
    const value = await home();
    assert.deepEqual(value.pendingWork, baseline.pendingWork);
    assert.equal(value.todayOrderCount, baseline.todayOrderCount);
    assert.equal(value.todayCallCount, baseline.todayCallCount);
    assert.ok(!value.incompleteDrafts.some((row) => row.draftSeq === added));
  } finally {
    repository.adminStatusCounts = original;
  }
  assert.equal((await home()).pendingWork.incomplete, baseline.pendingWork.incomplete + 1);
  assert.equal((await home()).todayOrderCount, baseline.todayOrderCount + 1);
});

test('home requires an active administrator, supports all existing roles and documents reusable payloads', async () => {
  for (let actor = 0; actor < 3; actor++) await compareWithLists(await home(actor));
  await f.error(await f.get('/api/dashboard/home', 0, { Cookie: undefined }), 401, 'UNAUTHORIZED');
  await f.error(
    await f.get('/api/dashboard/home', 0, { Cookie: undefined, ...businessHeaders() }),
    401,
    'UNAUTHORIZED',
  );
  const spec = await json(await f.get('/api/docs-json'));
  assert.ok(spec.paths['/api/dashboard/home'].get);
  assert.deepEqual(
    Object.keys(spec.components.schemas.HomeDto.properties).sort(),
    [
      'observedAt',
      'todayOrderCount',
      'todayCallCount',
      'pendingWork',
      'recentCalls',
      'incompleteDrafts',
      'unansweredQuestions',
      'aiPerformance',
    ].sort(),
  );
  assert.equal(spec.components.schemas.HomeDto.properties.incompleteDrafts.maxItems, 11);
});

test('today counts use KST midnight, actual orders, call start precedence and existing visibility rules', async () => {
  const first = '2094-05-31T15:00:00.000Z';
  const last = '2094-06-01T14:59:59.999Z';
  const next = '2094-06-01T15:00:00.000Z';
  const before = '2094-05-31T14:59:59.999Z';
  async function order(at, changes = {}) {
    const id = (
      await f.pool.query(
        `INSERT INTO orders(status,payment_method_type,total_amount,created_at,deleted_at)
       VALUES($1,'billing',1000,$2,$3) RETURNING order_seq`,
        [changes.status ?? 'notPaid', at, changes.deleted ? new Date() : null],
      )
    ).rows[0].order_seq;
    orderIds.push(id);
    return id;
  }
  async function call(incoming, started = incoming, changes = {}) {
    const id = (
      await f.pool.query(
        `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at,deleted_at)
       VALUES($1,$2,$3,$3,$4) RETURNING call_session_seq`,
        ['home-day-' + randomUUID(), incoming, started, changes.deleted ? new Date() : null],
      )
    ).rows[0].call_session_seq;
    callIds.push(id);
    return id;
  }
  await order(first);
  await order(last);
  await order(first, { status: 'CANCELLED' });
  await order(before);
  await order(next);
  await order(first, { deleted: true });
  const legacy = await order(first);
  const copied = await draft();
  await f.pool.query('UPDATE order_parcel_drafts SET legacy_order_seq=$1 WHERE draft_seq=$2', [
    legacy,
    copied,
  ]);
  await draft();
  await call(first);
  await call(last);
  await call(before);
  await call(next);
  await call(first, before);
  await call(first, null);
  await call(first, first, { deleted: true });
  await call('2000-01-01', first);
  const analysed = await call(before, null);
  await f.pool.query(
    `INSERT INTO call_analyses(call_session_seq,ai_started_at,ai_ended_at,has_complaint,complaints,payload_hash,is_new_customer,registered_parcel_count)
     VALUES($1,$2,$2,false,'[]',repeat('a',64),true,0)`,
    [analysed, first],
  );
  const client = await f.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const repository = f.app.get(DashboardRepository);
    assert.deepEqual(await repository.todayCounts(new Date(last), client), {
      todayOrderCount: 3,
      todayCallCount: 4,
    });
    assert.deepEqual(await repository.todayCounts(new Date(next), client), {
      todayOrderCount: 1,
      todayCallCount: 1,
    });
    assert.deepEqual(await repository.todayCounts(new Date('2094-06-03T00:00:00+09:00'), client), {
      todayOrderCount: 0,
      todayCallCount: 0,
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
