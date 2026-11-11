const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const { DverClient } = require('../dist/orders/dver.client');
const { RetentionRepository } = require('../dist/retention/retention.repository');
const { AuditService } = require('../dist/audit/audit.service');
const { orderDraft } = require('../dist/orders/order-draft');
const f = applicationFixture('관리자 초안 보완');
let customer,
  calls = 0;
const address = {
  name: '관리자 초안',
  phoneNumber: '01070000001',
  roadAddress: '초안 보완로 1',
  jibunAddress: '초안 보완동 1',
  dongName: '보완동',
  postalCode: '01234',
  detailAddress: '',
};
const parcel = () => ({
  origin: { ...address },
  destination: { ...address },
  smallBoxCount: 1,
  itemPrice: 10000,
  notifiedPrice: 3500,
});
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()).data;
}
async function setup() {
  customer = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status,monthly_billing_enabled) VALUES('보완 고객','01070000001','ACTIVE',true) RETURNING customer_seq",
    )
  ).rows[0].customer_seq;
  const dver = f.app.get(DverClient);
  dver.ensureConfigured = () => {};
  dver.submit = async () => {
    calls++;
    return { status: 'ACCEPTED', parcelNo: 'ADMIN055', receivedAt: new Date().toISOString() };
  };
}
const create = (changes = {}) =>
  f.write('POST', '/api/parcel-drafts', {
    clientParcelId: randomUUID(),
    customerSeq: customer,
    status: 'READY',
    parcel: parcel(),
    ...changes,
  });
const submit = (draft, changes = {}, actor = 0) =>
  f.write(
    'POST',
    `/api/admin/parcel-drafts/${draft.draftSeq}/submit`,
    { expectedVersion: draft.version, paymentMethodType: 'billing', ...changes },
    actor,
  );
async function sourceCall(withComplete = false) {
  const id = (
    await f.pool.query(
      "INSERT INTO call_sessions(provider_call_id,customer_seq,caller_phone_number,incoming_at) VALUES($1,$2,'01070000001',clock_timestamp()-interval '2 minutes') RETURNING call_session_seq",
      [randomUUID(), customer],
    )
  ).rows[0].call_session_seq;
  const ai = {
    Cookie: undefined,
    Origin: undefined,
    ...businessHeaders(),
    call_session_seq: String(id),
  };
  if (withComplete)
    await data(
      await f.write(
        'POST',
        '/api/parcel-drafts',
        { clientParcelId: randomUUID(), status: 'READY', parcel: parcel() },
        0,
        ai,
      ),
      201,
    );
  const incomplete = await data(
    await f.write(
      'POST',
      '/api/parcel-drafts',
      { clientParcelId: randomUUID(), status: 'EDITING', parcel: parcel() },
      0,
      ai,
    ),
    201,
  );
  await f.pool.query(
    'UPDATE call_sessions SET started_at=incoming_at,ended_at=clock_timestamp() WHERE call_session_seq=$1',
    [id],
  );
  const finalized = await data(
    await f.write(
      'POST',
      `/api/calls/${id}/order-intake/complete`,
      {
        expectedIntakeVersion: incomplete.intakeVersion,
        ...(withComplete ? { paymentMethodType: 'billing' } : {}),
      },
      0,
      ai,
    ),
  );
  return { id, ai, incomplete, finalized };
}

test('admin resumes one incomplete parcel into a separate order and leaves the original call order untouched', async () => {
  await setup();
  const source = await sourceCall(true);
  const original = source.finalized.orderSeq;
  const pinCount = async () =>
    (
      await f.pool.query('SELECT count(*)::int AS n FROM personal_pins WHERE customer_seq=$1', [
        customer,
      ])
    ).rows[0].n;
  assert.equal(await pinCount(), 0);
  const before = (
    await f.pool.query('SELECT to_jsonb(o) AS value FROM orders o WHERE order_seq=$1', [original])
  ).rows[0].value;
  const resumed = await data(await create({ sourceDraftSeq: source.incomplete.draftSeq }), 201);
  assert.equal(resumed.callSessionSeq, null);
  assert.equal(resumed.sourceDraftSeq, source.incomplete.draftSeq);
  assert.equal(resumed.reservedOrderSeq, source.incomplete.reservedOrderSeq);
  const result = await data(await submit(resumed));
  assert.equal(result.orderSeq, source.incomplete.reservedOrderSeq);
  assert.notEqual(result.orderSeq, original);
  assert.equal(result.status, 'notPaid');
  assert.equal(result.callSessionSeq, null);
  assert.equal(result.draftSeq, resumed.draftSeq);
  assert.deepEqual(
    (await f.pool.query('SELECT to_jsonb(o) AS value FROM orders o WHERE order_seq=$1', [original]))
      .rows[0].value,
    before,
  );
  assert.equal(
    (
      await f.pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [
        source.id,
      ])
    ).rows[0].order_seq,
    original,
  );
  assert.equal(
    (await f.pool.query('SELECT creation_source FROM orders WHERE order_seq=$1', [result.orderSeq]))
      .rows[0].creation_source,
    'ADMIN',
  );
  const replay = await data(await submit(resumed));
  assert.equal(replay.orderSeq, result.orderSeq);
  assert.equal(await pinCount(), 1);
  const detail = await data(await f.get('/api/parcel-drafts/' + resumed.draftSeq));
  assert.equal(detail.orderSeq, result.orderSeq);
  assert.equal(detail.orderParcelSeq, result.orderParcelSeq);
});

test('admin draft submit keeps role/origin checks, version validation and READY completeness', async () => {
  const editing = await data(
    await create({ status: 'EDITING', parcel: { origin: { roadAddress: '일부 주소' } } }),
    201,
  );
  await f.error(await submit(editing), 409, 'INVALID_STATE');
  const ready = await data(await create(), 201);
  await f.error(await submit(ready, { expectedVersion: 0 }), 400, 'INVALID_REQUEST');
  await f.error(await submit(ready, { expectedVersion: 2 }), 409, 'VERSION_CONFLICT');
  await f.error(
    await f.write(
      'POST',
      `/api/admin/parcel-drafts/${ready.draftSeq}/submit`,
      { expectedVersion: 1, paymentMethodType: 'billing' },
      0,
      { Cookie: undefined, ...businessHeaders() },
    ),
    401,
    'UNAUTHORIZED',
  );
  await f.error(
    await f.write(
      'POST',
      `/api/admin/parcel-drafts/${ready.draftSeq}/submit`,
      { expectedVersion: 1, paymentMethodType: 'billing' },
      0,
      { Origin: undefined },
    ),
    403,
    'FORBIDDEN',
  );
  assert.equal((await data(await submit(ready, {}, 2))).status, 'notPaid');
});

test('simultaneous admin final submits create a single order/payment and failed audit rolls back conversion', async () => {
  const ready = await data(await create(), 201);
  const responses = await Promise.all([submit(ready), submit(ready, {}, 1)]);
  const results = [];
  for (const r of responses) results.push(await data(r));
  assert.equal(results[0].orderSeq, results[1].orderSeq);
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM order_payment_requests WHERE order_seq=$1',
        [results[0].orderSeq],
      )
    ).rows[0].n,
    1,
  );
  const next = await data(await create(), 201);
  const audit = f.app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (event, client) {
    if (event.action === 'PARCEL_DRAFT_CONVERTED') throw Error('draft audit rollback');
    return original.call(this, event, client);
  };
  try {
    assert.equal((await submit(next)).status, 500);
  } finally {
    audit.recordSuccess = original;
  }
  const saved = await data(await f.get('/api/parcel-drafts/' + next.draftSeq));
  assert.equal(saved.status, 'READY');
  assert.equal(saved.orderSeq, null);
  assert.equal((await data(await submit(next))).status, 'notPaid');
});

test('admin monthly conversion sends only once and actual order correction remains supported', async () => {
  const ready = await data(await create(), 201);
  const before = calls;
  const result = await data(await submit(ready, { paymentMethodType: 'credit' }));
  assert.equal(result.status, 'ACCEPTED');
  assert.equal(calls, before + 1);
  await data(await submit(ready, { paymentMethodType: 'credit' }));
  assert.equal(calls, before + 1);
  const order = await data(await f.get('/api/orders/' + result.orderSeq));
  assert.equal(
    (
      await f.write('PATCH', '/api/orders/' + result.orderSeq, {
        expectedVersion: order.version,
        parcels: [{ orderParcelSeq: result.orderParcelSeq, clientComment: '기존 내부 보정' }],
      })
    ).status,
    200,
  );
  const after = await data(await f.get('/api/orders/' + result.orderSeq));
  assert.equal(after.status, 'ACCEPTED');
  assert.equal(after.parcels[0].clientComment, '기존 내부 보정');
  assert.equal(calls, before + 1);
});

test('soft-deleting a converted draft leaves actual order and sibling/source text intact', async () => {
  const source = await sourceCall();
  const resumed = await data(await create({ sourceDraftSeq: source.incomplete.draftSeq }), 201);
  const result = await data(await submit(resumed));
  const before = await data(await f.get('/api/orders/' + result.orderSeq));
  const response = await f.write('DELETE', '/api/parcel-drafts', { draftSeqs: [resumed.draftSeq] });
  assert.equal(response.status, 204);
  await f.error(await f.get('/api/parcel-drafts/' + resumed.draftSeq), 404, 'NOT_FOUND');
  assert.deepEqual(await data(await f.get('/api/orders/' + result.orderSeq)), before);
  const original = await data(await f.get('/api/parcel-drafts/' + source.incomplete.draftSeq));
  assert.equal(original.status, 'RESUMED');
  assert.equal(original.parcel.origin.roadAddress, address.roadAddress);
});

test('a pending intake cannot lose its call or draft before finalization, and finalized call deletion keeps the draft', async () => {
  const id = (
    await f.pool.query(
      "INSERT INTO call_sessions(provider_call_id,customer_seq,caller_phone_number,incoming_at) VALUES($1,$2,'01070000001',clock_timestamp()-interval '2 minutes') RETURNING call_session_seq",
      [randomUUID(), customer],
    )
  ).rows[0].call_session_seq;
  const ai = {
    Cookie: undefined,
    Origin: undefined,
    ...businessHeaders(),
    call_session_seq: String(id),
  };
  const draft = await data(
    await f.write(
      'POST',
      '/api/parcel-drafts',
      {
        clientParcelId: randomUUID(),
        status: 'EDITING',
        parcel: { origin: { roadAddress: '삭제 보존' } },
      },
      0,
      ai,
    ),
    201,
  );
  await f.pool.query(
    'UPDATE call_sessions SET started_at=incoming_at,ended_at=clock_timestamp() WHERE call_session_seq=$1',
    [id],
  );
  await f.error(
    await f.write('DELETE', '/api/calls', { callSessionSeqs: [id] }),
    409,
    'INVALID_STATE',
  );
  await f.error(
    await f.write('DELETE', '/api/parcel-drafts', { draftSeqs: [draft.draftSeq] }),
    409,
    'INVALID_STATE',
  );
  assert.equal(
    (
      await data(
        await f.write(
          'POST',
          `/api/calls/${id}/order-intake/complete`,
          { expectedIntakeVersion: draft.intakeVersion },
          0,
          ai,
        ),
      )
    ).status,
    'NO_ORDER',
  );
  assert.equal((await f.write('DELETE', '/api/calls', { callSessionSeqs: [id] })).status, 204);
  assert.equal(
    (await data(await f.get('/api/parcel-drafts/' + draft.draftSeq))).parcel.origin.roadAddress,
    '삭제 보존',
  );
});

test('migrated collecting orders are excluded once and cannot be resubmitted or mutated through the old resource', async () => {
  const name = 'legacy-draft-' + randomUUID();
  const created = await data(
    await f.write(
      'POST',
      '/api/orders',
      { customerSeq: customer, parcels: [{ origin: { name, roadAddress: '이관 주소' } }] },
      0,
      { 'Idempotency-Key': randomUUID() },
    ),
    201,
  );
  const old = await data(await f.get('/api/orders/' + created.orderSeq));
  const snapshot = orderDraft({ parcels: [old.parcels[0]] }).parcels[0];
  const id = (
    await f.pool.query(
      "INSERT INTO order_parcel_drafts(customer_seq,created_by_admin_user_seq,client_parcel_id,creation_payload,parcel_data,status,legacy_order_seq,legacy_order_parcel_seq) VALUES($1,$2,$3,'{}',$4,'INCOMPLETE',$5,$6) RETURNING draft_seq",
      [customer, f.ids[0], randomUUID(), snapshot, old.orderSeq, old.parcels[0].orderParcelSeq],
    )
  ).rows[0].draft_seq;
  for (const path of [
    '/api/orders?customerSeq=' + customer,
    '/api/admin/orders?q=' + encodeURIComponent(name),
  ]) {
    const list = await f.get(path);
    assert.equal(list.status, 200);
    assert.ok(!(await list.json()).data.some((row) => row.orderSeq === old.orderSeq));
  }
  const list = await f.get('/api/parcel-drafts?legacyOrderSeq=' + old.orderSeq);
  assert.deepEqual(
    (await list.json()).data.map((row) => row.draftSeq),
    [id],
  );
  for (const [method, path, body] of [
    ['PATCH', '/api/orders/' + old.orderSeq, { expectedVersion: old.version, totalAmount: 3500 }],
    ['POST', `/api/orders/${old.orderSeq}/submit`, { expectedVersion: old.version }],
    ['POST', `/api/orders/${old.orderSeq}/cancel`, {}],
  ])
    await f.error(await f.write(method, path, body), 409, 'INVALID_STATE');
  assert.deepEqual(await data(await f.get('/api/orders/' + old.orderSeq)), old);
  assert.equal((await f.write('DELETE', '/api/orders', { orderSeqs: [old.orderSeq] })).status, 204);
  assert.equal(
    (await data(await f.get('/api/parcel-drafts/' + id))).parcel.origin.roadAddress,
    '이관 주소',
  );
});

test('five-year draft purge is independent from weekly logs and from the converted actual order', async () => {
  const ready = await data(await create(), 201);
  const result = await data(await submit(ready));
  const active = await data(await create({ status: 'EDITING' }), 201);
  await f.write('DELETE', '/api/parcel-drafts', { draftSeqs: [active.draftSeq] });
  await f.pool.query(
    "UPDATE order_parcel_drafts SET deleted_at=clock_timestamp()-interval '8 days' WHERE draft_seq=$1",
    [active.draftSeq],
  );
  await f.pool.query(
    "UPDATE order_parcel_drafts SET retention_started_at=clock_timestamp()-interval '5 years 1 day' WHERE draft_seq=$1",
    [ready.draftSeq],
  );
  const auditId = (
    await f.pool.query(
      "INSERT INTO audit_logs(actor_type,action,target_type,target_seq,request_id,result,metadata,occurred_at) VALUES('SYSTEM','DRAFT_LOG_TEST','ORDER_PARCEL_DRAFT',$1,$2,'SUCCESS','{}',clock_timestamp()-interval '8 days') RETURNING audit_log_seq",
      [ready.draftSeq, randomUUID()],
    )
  ).rows[0].audit_log_seq;
  await f.app.get(RetentionRepository).purgeDatabase();
  assert.equal(
    (await f.pool.query('SELECT 1 FROM order_parcel_drafts WHERE draft_seq=$1', [ready.draftSeq]))
      .rowCount,
    0,
  );
  assert.equal(
    (await f.pool.query('SELECT 1 FROM audit_logs WHERE audit_log_seq=$1', [auditId])).rowCount,
    0,
  );
  assert.equal(
    (await f.pool.query('SELECT 1 FROM order_parcel_drafts WHERE draft_seq=$1', [active.draftSeq]))
      .rowCount,
    1,
  );
  assert.equal((await data(await f.get('/api/orders/' + result.orderSeq))).status, 'notPaid');
});
