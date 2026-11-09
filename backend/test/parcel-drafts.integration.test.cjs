const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { applicationFixture, businessHeaders } = require('./helpers/application.cjs');
const f = applicationFixture('배송 초안 검증');
const address = {
  name: '초안 고객',
  phoneNumber: '01077778888',
  roadAddress: '초안로 1',
  jibunAddress: '초안동 1',
  dongName: '초안동',
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
let customer, otherCustomer, call;
const callFor = async (id = customer) =>
  (
    await f.pool.query(
      'INSERT INTO call_sessions(provider_call_id,customer_seq,caller_phone_number,incoming_at) SELECT $1,customer_seq,phone_number,clock_timestamp() FROM customers WHERE customer_seq=$2 RETURNING call_session_seq',
      [randomUUID(), id],
    )
  ).rows[0].call_session_seq;
async function setup() {
  const rows = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('초안 고객','01077778888','ACTIVE'),('타 고객','01077779999','ACTIVE') RETURNING customer_seq",
    )
  ).rows;
  customer = rows[0].customer_seq;
  otherCustomer = rows[1].customer_seq;
  call = await callFor();
}
const headers = (id) => ({
  Cookie: undefined,
  Origin: undefined,
  ...businessHeaders(),
  call_session_seq: String(id),
});
const create = (body, id = call) => f.write('POST', '/api/parcel-drafts', body, 0, headers(id));
const patch = (draft, body, id = call) =>
  f.write('PATCH', '/api/parcel-drafts/' + draft.draftSeq, body, 0, headers(id));
const body = (changes = {}) => ({
  clientParcelId: randomUUID(),
  status: 'READY',
  parcel: parcel(),
  ...changes,
});
async function data(response, status = 201) {
  assert.equal(response.status, status, await response.clone().text());
  return (await response.json()).data;
}
const createDraft = async (input = body(), id = call) => data(await create(input, id));
const endCall = (id) =>
  f.pool.query(
    'UPDATE call_sessions SET started_at=incoming_at,ended_at=clock_timestamp() WHERE call_session_seq=$1',
    [id],
  );

test('new draft routes require AI bearer plus a registered call or an active admin session', async () => {
  await setup();
  await f.error(
    await f.write('POST', '/api/parcel-drafts', body(), 0, {
      Cookie: undefined,
      Origin: undefined,
    }),
    401,
    'UNAUTHORIZED',
  );
  await f.error(
    await f.write('POST', '/api/parcel-drafts', body(), 0, {
      Cookie: undefined,
      Origin: undefined,
      ...businessHeaders(),
    }),
    400,
    'INVALID_REQUEST',
  );
  await f.error(await create(body(), 2147483647), 404, 'NOT_FOUND');
  await f.error(await create(body({ customerSeq: otherCustomer })), 403, 'FORBIDDEN');
});

test('READY creation saves an independent snapshot and creates no order or payment', async () => {
  const counts = async () =>
    (
      await f.pool.query(
        'SELECT (SELECT count(*) FROM orders) AS orders,(SELECT count(*) FROM order_payment_requests) AS payments',
      )
    ).rows[0];
  const before = await counts();
  const draft = await createDraft();
  assert.equal(draft.status, 'READY');
  assert.ok(Number.isInteger(draft.reservedOrderSeq) && draft.reservedOrderSeq > 0);
  assert.equal(draft.version, 1);
  assert.ok(draft.intakeVersion > 1);
  assert.equal(draft.customerSeq, customer);
  assert.equal(draft.callSessionSeq, call);
  assert.equal(draft.parcel.origin.roadAddress, address.roadAddress);
  assert.equal(draft.creationPayload, undefined);
  assert.deepEqual(await counts(), before);
});

test('same create UUID replays once, changed content conflicts and listing never exposes the creation copy', async () => {
  const input = body();
  const first = await createDraft(input);
  const replay = await createDraft(input);
  assert.equal(replay.draftSeq, first.draftSeq);
  assert.equal(replay.reservedOrderSeq, first.reservedOrderSeq);
  assert.equal(replay.intakeVersion, first.intakeVersion);
  await f.error(
    await create({ ...input, parcel: { ...input.parcel, notifiedPrice: 4000 } }),
    409,
    'IDEMPOTENCY_KEY_REUSED',
  );
  const list = await f.get(
    '/api/parcel-drafts?status=ALL&limit=1&customerSeq=' + customer,
    0,
    headers(call),
  );
  assert.equal(list.status, 200);
  const result = await list.json();
  assert.equal(result.data.length, 1);
  assert.equal(result.hasNext, true);
  assert.ok(result.total_count >= 2);
  assert.equal(result.data[0].creationPayload, undefined);
});

test('input validation keeps the existing price/mobile/address rules and accepts partial EDITING data', async () => {
  await f.error(await create(body({ parcel: { itemPrice: 100000001 } })), 400, 'INVALID_REQUEST');
  await f.error(
    await create(body({ parcel: { origin: { phoneNumber: '1012345678' } } })),
    400,
    'INVALID_REQUEST',
  );
  await f.error(
    await create(body({ parcel: { origin: { latitude: 37 } } })),
    400,
    'INVALID_REQUEST',
  );
  await f.error(
    await create({ clientParcelId: randomUUID(), status: 'EDITING' }),
    400,
    'INVALID_REQUEST',
  );
  await f.error(
    await create(body({ parcel: { origin: { roadAddress: '일부 주소' } } })),
    422,
    'VALIDATION_FAILED',
  );
  const partial = await createDraft(
    body({ status: 'EDITING', parcel: { origin: { roadAddress: '일부 주소' } } }),
  );
  assert.equal(partial.parcel.destination.name, null);
});

test('edit start removes the old address and fee immediately and SAVE validates the merged snapshot', async () => {
  const draft = await createDraft();
  await f.error(
    await patch(draft, {
      expectedVersion: 1,
      action: 'SAVE',
      status: 'READY',
      parcel: { notifiedPrice: 4000 },
    }),
    409,
    'INVALID_STATE',
  );
  const editing = await data(
    await patch(draft, { expectedVersion: 1, action: 'START_EDIT', clearFields: ['destination'] }),
    200,
  );
  assert.equal(editing.status, 'EDITING');
  assert.equal(editing.parcel.destination.roadAddress, null);
  assert.equal(editing.parcel.notifiedPrice, null);
  await f.error(
    await patch(draft, {
      expectedVersion: 2,
      action: 'SAVE',
      status: 'READY',
      parcel: { destination: { roadAddress: '바뀐 도로' } },
    }),
    422,
    'VALIDATION_FAILED',
  );
  const saved = await data(
    await patch(draft, {
      expectedVersion: 2,
      action: 'SAVE',
      status: 'READY',
      parcel: { destination: { ...address, roadAddress: '바뀐 도로' }, notifiedPrice: 4000 },
    }),
    200,
  );
  assert.equal(saved.parcel.destination.roadAddress, '바뀐 도로');
  assert.equal(saved.parcel.origin.roadAddress, address.roadAddress);
  assert.equal(saved.version, 3);
  assert.equal(saved.status, 'READY');
  await f.error(
    await patch(draft, { expectedVersion: 2, action: 'CANCEL' }),
    409,
    'VERSION_CONFLICT',
  );
});

test('two concurrent mutations consume one expectedVersion exactly once', async () => {
  const draft = await createDraft();
  const responses = await Promise.all([
    patch(draft, { expectedVersion: 1, action: 'START_EDIT', clearFields: ['items'] }),
    patch(draft, { expectedVersion: 1, action: 'CANCEL' }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const row = await data(
    await f.get('/api/parcel-drafts/' + draft.draftSeq, 0, headers(call)),
    200,
  );
  assert.equal(row.version, 2);
});

test('AI cannot read another customer or mutate a different call draft', async () => {
  const mine = await createDraft();
  const otherCall = await callFor(otherCustomer);
  await f.error(
    await f.get('/api/parcel-drafts/' + mine.draftSeq, 0, headers(otherCall)),
    404,
    'NOT_FOUND',
  );
  await f.error(
    await f.get('/api/parcel-drafts?customerSeq=' + customer, 0, headers(otherCall)),
    403,
    'FORBIDDEN',
  );
  await f.error(
    await patch(mine, { expectedVersion: 1, action: 'CANCEL' }, await callFor()),
    404,
    'NOT_FOUND',
  );
});

test('post-end cleanup is accepted until the AI completion seal, then writes are frozen', async () => {
  const id = await callFor();
  await endCall(id);
  const draft = await createDraft(
    body({ status: 'EDITING', parcel: { origin: { name: '지연 저장' } } }),
    id,
  );
  await f.pool.query(
    "UPDATE call_sessions SET order_completion_received_at=clock_timestamp(),order_completion_payload='{}' WHERE call_session_seq=$1",
    [id],
  );
  await f.error(
    await patch(draft, { expectedVersion: 1, action: 'CANCEL' }, id),
    409,
    'INVALID_STATE',
  );
  await f.error(await create(body(), id), 409, 'INVALID_STATE');
});

test('resuming copies into the new call, preserves the original expiry and prevents concurrent double resume', async () => {
  const oldCall = await callFor();
  const original = await createDraft(
    body({ status: 'EDITING', parcel: { origin: { roadAddress: '재개할 주소' } } }),
    oldCall,
  );
  await endCall(oldCall);
  await f.pool.query(
    "UPDATE order_parcel_drafts SET status='INCOMPLETE',retention_started_at=clock_timestamp()-interval '1 hour' WHERE draft_seq=$1",
    [original.draftSeq],
  );
  const saved = (
    await f.pool.query('SELECT retention_started_at FROM order_parcel_drafts WHERE draft_seq=$1', [
      original.draftSeq,
    ])
  ).rows[0].retention_started_at;
  const input = {
    clientParcelId: randomUUID(),
    status: 'EDITING',
    sourceDraftSeq: original.draftSeq,
  };
  const firstCall = await callFor(),
    secondCall = await callFor();
  const results = await Promise.all([
    create(input, firstCall),
    create({ ...input, clientParcelId: randomUUID() }, secondCall),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const created = (await results.find((r) => r.status === 201).json()).data;
  assert.equal(created.sourceDraftSeq, original.draftSeq);
  assert.equal(created.version, 1);
  assert.equal(created.parcel.origin.roadAddress, '재개할 주소');
  assert.equal(new Date(created.retentionStartedAt).toISOString(), saved.toISOString());
  assert.equal(
    (
      await f.pool.query('SELECT status FROM order_parcel_drafts WHERE draft_seq=$1', [
        original.draftSeq,
      ])
    ).rows[0].status,
    'RESUMED',
  );
  const winningCall = created.callSessionSeq;
  const replay = await data(
    await create({ ...input, clientParcelId: created.clientParcelId }, winningCall),
  );
  assert.equal(replay.draftSeq, created.draftSeq);
});

test('admin standalone resume and edit retains the established admin role access', async () => {
  const draft = await data(
    await f.write(
      'POST',
      '/api/parcel-drafts',
      body({
        customerSeq: customer,
        status: 'EDITING',
        parcel: { origin: { roadAddress: '관리자 보완' } },
      }),
    ),
  );
  assert.equal(draft.callSessionSeq, null);
  assert.equal(draft.intakeVersion, null);
  const changed = await data(
    await f.write(
      'PATCH',
      '/api/parcel-drafts/' + draft.draftSeq,
      { expectedVersion: 1, action: 'SAVE', status: 'READY', parcel: parcel() },
      1,
    ),
    200,
  );
  assert.equal(changed.status, 'READY');
});

test('admin reads retain text and reference IDs after customer/call physical deletion, while expiry hides old drafts', async () => {
  const id = (
    await f.pool.query(
      "INSERT INTO customers(name,phone_number,status) VALUES('원본 삭제','01011115555','ACTIVE') RETURNING customer_seq",
    )
  ).rows[0].customer_seq;
  const callId = await callFor(id);
  const draft = await createDraft(body(), callId);
  await f.pool.query('DELETE FROM call_sessions WHERE call_session_seq=$1', [callId]);
  await f.pool.query('DELETE FROM customers WHERE customer_seq=$1', [id]);
  const detail = await data(await f.get('/api/parcel-drafts/' + draft.draftSeq), 200);
  assert.equal(detail.customerSeq, id);
  assert.equal(detail.callSessionSeq, callId);
  assert.equal(detail.parcel.origin.roadAddress, address.roadAddress);
  await f.pool.query(
    "UPDATE order_parcel_drafts SET retention_started_at=clock_timestamp()-interval '5 years' WHERE draft_seq=$1",
    [draft.draftSeq],
  );
  await f.error(await f.get('/api/parcel-drafts/' + draft.draftSeq), 404, 'NOT_FOUND');
});

test('unregistered callers keep partial drafts, cannot claim READY and can resume only their own ended call after registration', async () => {
  const phone = '01023334444';
  const unknownCall = async (number) =>
    (
      await f.pool.query(
        'INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at) VALUES($1,$2,clock_timestamp()) RETURNING call_session_seq',
        [randomUUID(), number],
      )
    ).rows[0].call_session_seq;
  const id = await unknownCall(phone);
  const saved = await createDraft(
    body({ status: 'EDITING', parcel: { origin: { roadAddress: '미등록 보존 주소' } } }),
    id,
  );
  assert.equal(saved.customerSeq, null);
  assert.equal(saved.callerPhoneNumber, phone);
  await f.error(
    await patch(
      saved,
      { expectedVersion: 1, action: 'SAVE', status: 'READY', parcel: parcel() },
      id,
    ),
    403,
    'FORBIDDEN',
  );
  await endCall(id);
  const seal = await f.write(
    'POST',
    `/api/calls/${id}/order-intake/complete`,
    { expectedIntakeVersion: saved.intakeVersion },
    0,
    headers(id),
  );
  assert.equal((await data(seal, 200)).status, 'NO_ORDER');
  const foreign = await unknownCall('01023335555');
  await f.error(
    await f.get('/api/parcel-drafts/' + saved.draftSeq, 0, headers(foreign)),
    404,
    'NOT_FOUND',
  );
  assert.deepEqual(
    (await (await f.get('/api/parcel-drafts', 0, headers(foreign))).json()).data,
    [],
  );
  await f.pool.query('DELETE FROM call_sessions WHERE call_session_seq=$1', [id]);
  assert.equal(
    (await data(await f.get('/api/parcel-drafts/' + saved.draftSeq), 200)).callerPhoneNumber,
    phone,
  );
  const registered = await data(
    await f.write(
      'POST',
      '/api/customers',
      {
        name: '나중 등록',
        phoneNumber: phone,
        address: {
          roadAddress: '등록로',
          jibunAddress: '등록동',
          dongName: '등록동',
          postalCode: '01234',
        },
      },
      0,
      headers(id),
    ),
    201,
  );
  const next = await unknownCall(phone);
  const list = await f.get('/api/parcel-drafts', 0, headers(next));
  assert.ok((await list.json()).data.some((row) => row.draftSeq === saved.draftSeq));
  const resumed = await createDraft(
    { clientParcelId: randomUUID(), status: 'EDITING', sourceDraftSeq: saved.draftSeq },
    next,
  );
  assert.equal(resumed.customerSeq, registered.customerSeq);
  assert.equal(resumed.parcel.origin.roadAddress, '미등록 보존 주소');
  assert.equal(
    (
      await f.pool.query('SELECT customer_seq FROM order_parcel_drafts WHERE draft_seq=$1', [
        saved.draftSeq,
      ])
    ).rows[0].customer_seq,
    registered.customerSeq,
  );
});

test('retired COMPANY references may resume only the unchanged historical address and never authorize a new selection', async () => {
  await f.error(
    await create(body({ parcel: { ...parcel(), originPin: { scope: 'COMPANY', pinSeq: 901 } } })),
    403,
    'FORBIDDEN',
  );
  const oldCall = await callFor();
  const source = await createDraft(body({ status: 'EDITING' }), oldCall);
  await endCall(oldCall);
  await f.pool.query(
    'UPDATE order_parcel_drafts SET status=\'INCOMPLETE\',parcel_data=jsonb_set(parcel_data,\'{originPin}\',\'{"scope":"COMPANY","pinSeq":901}\') WHERE draft_seq=$1',
    [source.draftSeq],
  );
  const next = await callFor();
  const resumed = await createDraft(
    { clientParcelId: randomUUID(), sourceDraftSeq: source.draftSeq, status: 'READY' },
    next,
  );
  assert.deepEqual(resumed.parcel.originPin, { scope: 'COMPANY', pinSeq: 901 });
  const editing = await data(
    await patch(
      resumed,
      { expectedVersion: 1, action: 'START_EDIT', clearFields: ['items'] },
      next,
    ),
    200,
  );
  const saved = await data(
    await patch(
      resumed,
      {
        expectedVersion: editing.version,
        action: 'SAVE',
        status: 'READY',
        parcel: { smallBoxCount: 2, notifiedPrice: 4000 },
      },
      next,
    ),
    200,
  );
  assert.deepEqual(saved.parcel.originPin, { scope: 'COMPANY', pinSeq: 901 });
  const addressEdit = await data(
    await patch(
      resumed,
      { expectedVersion: saved.version, action: 'START_EDIT', clearFields: ['origin'] },
      next,
    ),
    200,
  );
  await f.error(
    await patch(
      resumed,
      {
        expectedVersion: addressEdit.version,
        action: 'SAVE',
        status: 'READY',
        parcel: {
          origin: { ...address, roadAddress: '다른 주소' },
          originPin: { scope: 'COMPANY', pinSeq: 901 },
          notifiedPrice: 4000,
        },
      },
      next,
    ),
    403,
    'FORBIDDEN',
  );
});
