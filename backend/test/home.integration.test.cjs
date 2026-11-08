const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const { OrdersRepository } = require('../dist/orders/orders.repository');
const f = applicationFixture('홈 QA');
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
  return (
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
}
async function compareWithLists(value) {
  const orders = await json(await f.get('/api/admin/orders?limit=5'));
  const drafts = await json(await f.get('/api/parcel-drafts?status=INCOMPLETE&limit=5'));
  const calls = await json(await f.get('/api/calls?limit=5'));
  const questions = await json(await f.get('/api/unanswered-questions?status=OPEN&limit=5'));
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
    assert.ok(rows.length <= 5);
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
  for (let i = 0; i < 7; i++) {
    kept.push(await draft());
    const call = (
      await f.pool.query(
        `INSERT INTO call_sessions(provider_call_id,incoming_at,started_at,ended_at)
       VALUES($1,'2097-01-01','2097-01-01','2097-01-01T00:01:00Z') RETURNING call_session_seq`,
        ['home-' + randomUUID()],
      )
    ).rows[0].call_session_seq;
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
    await f.pool.query(
      "INSERT INTO orders(status,payment_method_type,total_amount) VALUES($1,'billing',1000)",
      [status],
    );
  const value = await home();
  assert.deepEqual(value.pendingWork, {
    incomplete: baseline.incomplete + 7,
    notPaid: baseline.notPaid + 1,
    submissionFailed: baseline.submissionFailed + 2,
    unansweredQuestions: baseline.unansweredQuestions + 7,
  });
  assert.equal(value.incompleteDrafts.length, 5);
  assert.equal(value.recentCalls.length, 5);
  assert.equal(value.unansweredQuestions.length, 5);
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
    return result;
  };
  try {
    const value = await home();
    assert.deepEqual(value.pendingWork, baseline.pendingWork);
    assert.ok(!value.incompleteDrafts.some((row) => row.draftSeq === added));
  } finally {
    repository.adminStatusCounts = original;
  }
  assert.equal((await home()).pendingWork.incomplete, baseline.pendingWork.incomplete + 1);
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
      'pendingWork',
      'recentCalls',
      'incompleteDrafts',
      'unansweredQuestions',
      'aiPerformance',
    ].sort(),
  );
  assert.equal(spec.components.schemas.HomeDto.properties.incompleteDrafts.maxItems, 5);
});
