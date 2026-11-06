const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const { ConfigService } = require('@nestjs/config');
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const { testMembership } = require('./helpers/membership.cjs');
const { OrderIntakeService } = require('../dist/orders/order-intake.service');
const { OrderPaymentsService } = require('../dist/orders/order-payments.service');
const { OrderMaintenanceWorker } = require('../dist/orders/order-maintenance.worker');
const { AuditService } = require('../dist/audit/audit.service');
process.env.PBX_WEBHOOK_TOKEN = randomBytes(32).toString('hex');
process.env.S3_RECORDINGS_BUCKET = '';
const f = applicationFixture('통화 주문 확정');
let server,
  external,
  sequence = 60000000;
let dverRequests = [],
  rejectDver = false;
after(async () => {
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
});
async function setup() {
  server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    dverRequests.push(JSON.parse(text));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify(
        rejectDver
          ? { ok: false }
          : { ok: true, parcelNo: 'INTK0055', receivedAt: new Date().toISOString() },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  external = `http://127.0.0.1:${server.address().port}/parcel`;
  configure(f.app);
}
function configure(app) {
  app.get(ConfigService).set('DVER_API_URL', external);
  app.get(ConfigService).set('DVER_API_KEY', 'intake-test-key');
}
async function call(known = true) {
  const phone = '010' + String(++sequence);
  const customer = known
    ? (
        await f.pool.query(
          "INSERT INTO customers(name,phone_number,status,monthly_billing_enabled) VALUES('확정 고객',$1,'ACTIVE',true) RETURNING customer_seq",
          [phone],
        )
      ).rows[0].customer_seq
    : null;
  const incomingAt = new Date(Date.now() - 120000).toISOString();
  const providerCallId = randomUUID();
  const id = (
    await f.pool.query(
      'INSERT INTO call_sessions(provider_call_id,customer_seq,caller_phone_number,incoming_at) VALUES($1,$2,$3,$4) RETURNING call_session_seq',
      [providerCallId, customer, phone, incomingAt],
    )
  ).rows[0].call_session_seq;
  return { id, customer, phone, incomingAt, providerCallId };
}
const address = (phone) => ({
  name: '발송 고객',
  phoneNumber: phone,
  roadAddress: '확정로 1',
  jibunAddress: '확정동 1',
  dongName: '확정동',
  postalCode: '01234',
  detailAddress: '',
});
const parcel = (c) => ({
  origin: address(c.phone),
  destination: address(c.phone),
  smallBoxCount: 1,
  itemPrice: 10000,
  notifiedPrice: 3500,
});
const aiHeaders = (c) => ({
  Cookie: undefined,
  Origin: undefined,
  ...businessHeaders(),
  call_session_seq: String(c.id),
});
async function data(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()).data;
}
const create = (c, changes = {}) =>
  f.write(
    'POST',
    '/api/parcel-drafts',
    { clientParcelId: randomUUID(), status: 'READY', parcel: parcel(c), ...changes },
    0,
    aiHeaders(c),
  );
const draft = async (c, changes = {}) => data(await create(c, changes), 201);
const get = (c) => f.get(`/api/calls/${c.id}/order-intake`, 0, aiHeaders(c));
const seal = (c, input, base = f.base) =>
  fetch(`${base}/api/calls/${c.id}/order-intake/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...businessHeaders() },
    body: JSON.stringify(input),
  });
const completeInput = (last, paymentMethodType = 'billing') => ({
  expectedIntakeVersion: last.intakeVersion,
  paymentMethodType,
  pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
});
async function end(c) {
  const payload = {
    recordingId: randomUUID(),
    callFrom: c.phone,
    callTo: '07012345678',
    startedAt: c.incomingAt,
    endedAt: new Date(Date.parse(c.incomingAt) + 60000).toISOString(),
    durationSeconds: 60,
    recordingUrl: 'https://recordings.example.invalid/intake.mp3',
  };
  const response = await f.write('POST', '/webhooks/pbx/call-ended', payload, 0, {
    Cookie: undefined,
    Origin: undefined,
    Authorization: 'Bearer ' + process.env.PBX_WEBHOOK_TOKEN,
  });
  assert.equal(response.status, 200, await response.clone().text());
}
const orderCount = async () =>
  (await f.pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;

test('PBX first waits for AI, then READY alone becomes a card-pending order with a stable conversion map', async () => {
  await setup();
  dverRequests = [];
  const c = await call();
  const ready = await draft(c);
  const partial = await draft(c, {
    status: 'EDITING',
    parcel: { origin: { roadAddress: '미완료 주소' } },
  });
  const cancelled = await draft(c);
  const cancel = await data(
    await f.write(
      'PATCH',
      '/api/parcel-drafts/' + cancelled.draftSeq,
      { expectedVersion: 1, action: 'CANCEL' },
      0,
      aiHeaders(c),
    ),
  );
  const before = await orderCount();
  await end(c);
  assert.equal((await data(await get(c))).status, 'WAITING_AI');
  assert.equal(await orderCount(), before);
  await f.app.get(OrderIntakeService).recoverPending();
  assert.equal(await orderCount(), before);
  const input = completeInput(cancel);
  const result = await data(await seal(c, input));
  assert.equal(result.status, 'FINALIZED');
  assert.equal(result.order.status, 'notPaid');
  assert.equal(result.order.totalAmount, 3500);
  assert.equal(result.order.paymentRequest.amount, 3500);
  assert.equal(result.parcelMappings.length, 1);
  assert.equal(result.parcelMappings[0].draftSeq, ready.draftSeq);
  assert.equal(
    (
      await f.pool.query('SELECT status FROM order_parcel_drafts WHERE draft_seq=$1', [
        partial.draftSeq,
      ])
    ).rows[0].status,
    'INCOMPLETE',
  );
  assert.equal(dverRequests.length, 0);
  const replay = await data(await seal(c, input));
  assert.equal(replay.orderSeq, result.orderSeq);
  assert.equal(await orderCount(), before + 1);
  await f.error(
    await seal(c, { ...input, paymentMethodType: 'credit' }),
    409,
    'EVENT_PAYLOAD_CONFLICT',
  );
  await f.error(await create(c), 409, 'INVALID_STATE');
});

test('AI first freezes inputs and creates no order, payment or Dver POST until the PBX arrives', async () => {
  dverRequests = [];
  const c = await call();
  const saved = await draft(c);
  const input = completeInput(saved, 'credit');
  const before = await orderCount();
  const waiting = await data(await seal(c, input));
  assert.equal(waiting.status, 'WAITING_PBX');
  assert.equal(await orderCount(), before);
  assert.equal(dverRequests.length, 0);
  await f.error(
    await f.write(
      'PATCH',
      '/api/parcel-drafts/' + saved.draftSeq,
      { expectedVersion: 1, action: 'CANCEL' },
      0,
      aiHeaders(c),
    ),
    409,
    'INVALID_STATE',
  );
  await end(c);
  await f.app.get(OrderIntakeService).recoverPending();
  const result = await data(await get(c));
  assert.equal(result.status, 'FINALIZED');
  assert.equal(result.order.status, 'ACCEPTED');
  assert.equal(dverRequests.length, 1);
  assert.equal(dverRequests[0].outboundParcels.length, 1);
  await f.app.get(OrderMaintenanceWorker).run();
  assert.equal(dverRequests.length, 1);
});

test('multiple complete parcels are billed and submitted in one whole-order Dver request', async () => {
  dverRequests = [];
  const c = await call();
  await companyFor(c);
  await draft(c);
  const last = await draft(c, { parcel: { ...parcel(c), notifiedPrice: 4200 } });
  await end(c);
  const result = await data(await seal(c, completeInput(last, 'credit')));
  assert.equal(result.order.status, 'ACCEPTED');
  assert.equal(result.order.totalAmount, 7700);
  assert.equal(result.parcelMappings.length, 2);
  assert.equal(dverRequests.length, 1);
  assert.equal(dverRequests[0].outboundParcels.length, 2);
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM order_billing_charges WHERE order_seq=$1',
        [result.orderSeq],
      )
    ).rows[0].n,
    1,
  );
});

test('card approval after finalization uses the existing verified-provider seam and sends Dver exactly once', async () => {
  dverRequests = [];
  const c = await call();
  const saved = await draft(c);
  await end(c);
  const result = await data(await seal(c, completeInput(saved)));
  const request = result.order.paymentRequest;
  const payments = f.app.get(OrderPaymentsService);
  const key = 'verified-' + randomUUID();
  const approvedAt = new Date().toISOString();
  await payments.claimApproval(request.paymentRequestId, 3500, key);
  await payments.recordApproval(request.paymentRequestId, key, approvedAt);
  assert.equal(
    (await payments.confirmPayment(request.paymentRequestId, 3500, key, randomUUID(), approvedAt))
      .status,
    'ACCEPTED',
  );
  assert.equal(dverRequests.length, 1);
  assert.equal(
    (await payments.confirmPayment(request.paymentRequestId, 3500, key, randomUUID(), approvedAt))
      .status,
    'ACCEPTED',
  );
  assert.equal(dverRequests.length, 1);
});

test('editing a formerly READY parcel excludes the old snapshot when the call is cut off', async () => {
  dverRequests = [];
  const c = await call();
  const ready = await draft(c);
  const edited = await draft(c);
  const last = await data(
    await f.write(
      'PATCH',
      '/api/parcel-drafts/' + edited.draftSeq,
      { expectedVersion: 1, action: 'START_EDIT', clearFields: ['destination'] },
      0,
      aiHeaders(c),
    ),
  );
  await end(c);
  const result = await data(await seal(c, completeInput(last, 'credit')));
  assert.deepEqual(
    result.parcelMappings.map((p) => p.draftSeq),
    [ready.draftSeq],
  );
  assert.equal(dverRequests[0].outboundParcels.length, 1);
  const incomplete = await data(await f.get('/api/parcel-drafts/' + edited.draftSeq));
  assert.equal(incomplete.status, 'INCOMPLETE');
  assert.equal(incomplete.parcel.destination.roadAddress, null);
});

test('empty, only-incomplete and all-cancelled calls finalize NO_ORDER without payment and keep the business draft', async () => {
  dverRequests = [];
  for (const state of ['EMPTY', 'EDITING', 'CANCELLED']) {
    const c = await call(false);
    let version = 1;
    if (state !== 'EMPTY') {
      const customer = (
        await f.pool.query(
          "INSERT INTO customers(name,phone_number,status) VALUES('통화 중 등록',$1,'ACTIVE') RETURNING customer_seq",
          [c.phone],
        )
      ).rows[0].customer_seq;
      const saved = await draft(c, {
        status: 'EDITING',
        parcel: { origin: { roadAddress: '보존할 주소' } },
      });
      version = saved.intakeVersion;
      assert.equal(
        (
          await f.pool.query('SELECT customer_seq FROM call_sessions WHERE call_session_seq=$1', [
            c.id,
          ])
        ).rows[0].customer_seq,
        customer,
      );
      if (state === 'CANCELLED')
        version = (
          await data(
            await f.write(
              'PATCH',
              '/api/parcel-drafts/' + saved.draftSeq,
              { expectedVersion: 1, action: 'CANCEL' },
              0,
              aiHeaders(c),
            ),
          )
        ).intakeVersion;
    }
    const before = await orderCount();
    await end(c);
    const result = await data(await seal(c, { expectedIntakeVersion: version }));
    assert.equal(result.status, 'NO_ORDER');
    assert.equal(result.orderSeq, null);
    assert.deepEqual(result.parcelMappings, []);
    assert.equal(await orderCount(), before);
  }
  assert.equal(dverRequests.length, 0);
});

test('a stale completion version or absent payment never seals the call and late cleanup can be retried', async () => {
  const c = await call();
  const first = await draft(c);
  const later = await draft(c);
  await end(c);
  await f.error(await seal(c, completeInput(first)), 409, 'VERSION_CONFLICT');
  await f.error(
    await seal(c, { expectedIntakeVersion: later.intakeVersion }),
    422,
    'VALIDATION_FAILED',
  );
  assert.equal((await data(await get(c))).status, 'WAITING_AI');
  const result = await data(await seal(c, completeInput(later)));
  assert.equal(result.order.totalAmount, 7000);
});

test('simultaneous completion retries across instances produce one order, one payment request and one audit', async () => {
  const c = await call();
  const saved = await draft(c);
  await end(c);
  const input = completeInput(saved);
  const app2 = await f.start();
  configure(app2);
  const base2 = await app2.getUrl();
  const responses = await Promise.all(
    Array.from({ length: 6 }, (_, i) => seal(c, input, i % 2 ? base2 : f.base)),
  );
  const results = [];
  for (const r of responses) results.push(await data(r));
  assert.equal(new Set(results.map((r) => r.orderSeq)).size, 1);
  const id = results[0].orderSeq;
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM order_payment_requests WHERE order_seq=$1',
        [id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*)::int AS n FROM audit_logs WHERE target_type='CALL_SESSION' AND target_seq=$1 AND action='ORDER_INTAKE_FINALIZED' AND result='SUCCESS'",
        [c.id],
      )
    ).rows[0].n,
    1,
  );
});

test('local finalization failure rolls back conversion/order/payment and a new instance recovers the durable seal', async () => {
  const c = await call();
  const saved = await draft(c);
  await end(c);
  const input = completeInput(saved);
  const count = await orderCount();
  const audit = f.app.get(AuditService),
    original = audit.recordSuccess;
  audit.recordSuccess = async function (event, client) {
    if (event.action === 'ORDER_CREATED') throw Error('finalization rollback');
    return original.call(this, event, client);
  };
  try {
    const failed = await data(await seal(c, input));
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.errorCode, 'INTERNAL_ERROR');
  } finally {
    audit.recordSuccess = original;
  }
  assert.equal(await orderCount(), count);
  assert.equal(
    (
      await f.pool.query(
        'SELECT status,order_parcel_seq FROM order_parcel_drafts WHERE draft_seq=$1',
        [saved.draftSeq],
      )
    ).rows[0].status,
    'READY',
  );
  assert.equal(
    (await f.pool.query('SELECT order_seq FROM call_sessions WHERE call_session_seq=$1', [c.id]))
      .rows[0].order_seq,
    null,
  );
  await f.pool.query(
    "UPDATE call_sessions SET order_finalization_attempted_at=clock_timestamp()-interval '1 minute' WHERE call_session_seq=$1",
    [c.id],
  );
  const app2 = await f.start();
  configure(app2);
  await app2.get(OrderIntakeService).recoverPending();
  const result = await data(await get(c));
  assert.equal(result.status, 'FINALIZED');
  assert.equal(result.errorCode, null);
  assert.equal(await orderCount(), count + 1);
});

test('Dver failure preserves the paid order and completion retries do not charge or POST again', async () => {
  dverRequests = [];
  rejectDver = true;
  const c = await call();
  await companyFor(c);
  const saved = await draft(c);
  await end(c);
  const input = completeInput(saved, 'credit');
  let result;
  try {
    result = await data(await seal(c, input));
  } finally {
    rejectDver = false;
  }
  assert.equal(result.order.status, 'SUBMITTING_FAILED');
  assert.equal(dverRequests.length, 1);
  const paid = (
    await f.pool.query('SELECT paid_at FROM orders WHERE order_seq=$1', [result.orderSeq])
  ).rows[0].paid_at;
  await data(await seal(c, input));
  assert.equal(dverRequests.length, 1);
  assert.equal(
    (
      await f.pool.query('SELECT paid_at FROM orders WHERE order_seq=$1', [result.orderSeq])
    ).rows[0].paid_at.toISOString(),
    paid.toISOString(),
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM order_billing_charges WHERE order_seq=$1',
        [result.orderSeq],
      )
    ).rows[0].n,
    1,
  );
});

test('new AI calls cannot bypass intake through old create, update, cancel or submit routes', async () => {
  const c = await call();
  await f.error(
    await f.write('POST', '/api/orders', { customerSeq: c.customer }, 0, {
      ...aiHeaders(c),
      'Idempotency-Key': randomUUID(),
    }),
    409,
    'INVALID_STATE',
  );
  const manual = await data(
    await f.write('POST', '/api/orders', { customerSeq: c.customer }, 0, {
      'Idempotency-Key': randomUUID(),
    }),
    201,
  );
  for (const [method, path, body] of [
    [
      'PATCH',
      `/api/orders/${manual.orderSeq}`,
      { expectedVersion: manual.version, totalAmount: 3500 },
    ],
    ['POST', `/api/orders/${manual.orderSeq}/cancel`, {}],
    ['POST', `/api/orders/${manual.orderSeq}/submit`, { expectedVersion: manual.version }],
  ])
    await f.error(await f.write(method, path, body, 0, aiHeaders(c)), 409, 'INVALID_STATE');
  await f.error(
    await f.write('POST', `/api/calls/${c.id}/order-intake/complete`, { expectedIntakeVersion: 1 }),
    401,
    'UNAUTHORIZED',
  );
});

async function companyFor(c) {
  const organization = (
    await f.pool.query(
      "INSERT INTO organizations(name,status,monthly_billing_enabled) VALUES('확정 기업','ACTIVE',true) RETURNING organization_seq",
    )
  ).rows[0].organization_seq;
  await testMembership(f.pool, {
    customerSeq: c.customer,
    organizationSeq: organization,
    employeeNo: randomUUID(),
    groupBillingEnabled: true,
  });
  return organization;
}
test('department group billing is held until end and records one company charge', async () => {
  dverRequests = [];
  const c = await call();
  await companyFor(c);
  const saved = await draft(c);
  const input = completeInput(saved, 'groupBilling');
  assert.equal((await data(await seal(c, input))).status, 'WAITING_PBX');
  assert.equal(dverRequests.length, 0);
  await end(c);
  await f.app.get(OrderIntakeService).recoverPending();
  const result = await data(await get(c));
  assert.equal(result.order.status, 'ACCEPTED');
  assert.equal(dverRequests.length, 1);
  assert.equal(
    (
      await f.pool.query(
        'SELECT count(*)::int AS n FROM order_billing_charges WHERE order_seq=$1',
        [result.orderSeq],
      )
    ).rows[0].n,
    1,
  );
});
