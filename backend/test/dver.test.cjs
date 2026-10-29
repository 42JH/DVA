require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { ConfigService } = require('@nestjs/config');
const { DverClient, dverPayload } = require('../dist/orders/dver.client');
const { orderDraft } = require('../dist/orders/order-draft');
const { SubmitOrderDto } = require('../dist/orders/dto/submit-order.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');

const address = {
  name: '검증 고객',
  phoneNumber: '01012345678',
  roadAddress: '검증로 1',
  jibunAddress: '검증동 1',
  dongName: '검증동',
  postalCode: '00001',
  latitude: 0,
  longitude: 0,
};
const complete = () =>
  orderDraft({
    customerSeq: 31,
    pickupRequestedAt: new Date(Date.now() + 86400000).toISOString(),
    parcels: [
      {
        origin: address,
        destination: address,
        smallBoxCount: 1,
        itemPrice: 0,
        notifiedPrice: 3500,
        originPin: { scope: 'PERSONAL', pinSeq: 1 },
      },
      {
        origin: address,
        destination: address,
        otherItemDescription: '기타 물품',
        itemPrice: Number.MAX_SAFE_INTEGER,
        notifiedPrice: 3500,
      },
    ],
  });
const success = { ok: true, parcelNo: 'TEST0057', receivedAt: '2026-10-27T10:00:00+09:00' };
let server, client, url, respond;
let requests = [];
before(async () => {
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
    respond(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${server.address().port}/parcel`;
  client = new DverClient(
    new ConfigService({ DVER_API_URL: url, DVER_API_KEY: 'test-only-dver-key' }),
  );
});
after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test('Dver excludes cancelled snapshots without changing the stored order', () => {
  const input = complete();
  input.parcels[0].status = 'CANCELLED';
  input.parcels[0].origin.name = null;
  const before = structuredClone(input);
  const payload = dverPayload(input);
  assert.equal(payload.outboundParcels.length, 1);
  assert.equal(payload.outboundParcels[0].item.etc, input.parcels[1].otherItemDescription);
  assert.equal(Object.hasOwn(payload.outboundParcels[0], 'status'), false);
  assert.deepEqual(input, before);
});

test('Dver v2 mapping sends each parcel and its own fee without internal identifiers', () => {
  const input = complete();
  const before = structuredClone(input);
  const payload = dverPayload(input);
  assert.deepEqual(input, before);
  assert.deepEqual(Object.keys(payload), [
    'paymentMethodType',
    'pickupRequestedAt',
    'outboundParcels',
  ]);
  assert.equal(payload.paymentMethodType, 'credit');
  assert.equal(payload.outboundParcels.length, 2);
  const parcel = payload.outboundParcels[0];
  assert.deepEqual(Object.keys(parcel), [
    'origin',
    'destination',
    'item',
    'clientComment',
    'notifiedPrice',
    'itemPrice',
  ]);
  assert.deepEqual(parcel.item, { document: 0, smallBox: 1, mediumBox: 0, bigBox: 0, etc: '' });
  assert.equal(parcel.origin.detailAddress, '');
  assert.equal(parcel.origin.postalCode, '00001');
  assert.equal(parcel.origin.latitude, 0);
  assert.equal(parcel.itemPrice, 0);
  assert.equal(parcel.notifiedPrice, 3500);
  assert.equal(payload.outboundParcels[1].notifiedPrice, 3500);
  assert.equal(payload.outboundParcels[1].itemPrice, Number.MAX_SAFE_INTEGER);
  assert.throws(
    () => dverPayload(orderDraft({})),
    (error) => error.getStatus() === 422,
  );
});

test('submit body accepts only a positive integer expectedVersion', async () => {
  const pipe = createValidationPipe();
  const validate = (body) => pipe.transform(body, { type: 'body', metatype: SubmitOrderDto });
  assert.equal((await validate({ expectedVersion: 2147483647 })).expectedVersion, 2147483647);
  for (const body of [
    {},
    ...[null, '1', 0, -1, 1.5, 2147483648].map((expectedVersion) => ({ expectedVersion })),
    { expectedVersion: 1, confirmed: true },
  ])
    await assert.rejects(
      () => validate(body),
      (error) => error.getStatus() === 400,
    );
});

test('Dver posts JSON with the configured key and accepts only the v2 success response', async () => {
  requests = [];
  respond = (_req, res) => res.end(JSON.stringify(success));
  const payload = dverPayload(complete());
  assert.deepEqual(await client.submit(payload), {
    status: 'ACCEPTED',
    parcelNo: success.parcelNo,
    receivedAt: success.receivedAt,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['x-api-key'], 'test-only-dver-key');
  assert.equal(requests[0].headers['content-type'], 'application/json');
  assert.deepEqual(requests[0].body, payload);
});

test('403 is AUTH_FAILED; errors, redirects and malformed success are never retried', async () => {
  for (const [status, body] of [
    [403, 'Authorization data is wrong!'],
    [500, 'internal error'],
    [429, 'busy'],
    [201, JSON.stringify(success)],
    [200, 'not JSON'],
    [200, 'null'],
    [200, JSON.stringify({ ...success, ok: false })],
    [200, JSON.stringify({ ...success, parcelNo: 'bad' })],
    [200, JSON.stringify({ ...success, receivedAt: '2026-02-30T10:00:00Z' })],
    [200, JSON.stringify({ ...success, receivedAt: '2026-10-27T10:00:00' })],
    [200, ' '.repeat(65537)],
    [302, 'redirect'],
  ]) {
    requests = [];
    respond = (_req, res) => {
      res.writeHead(status, { Location: url });
      res.end(body);
    };
    assert.deepEqual(await client.submit(dverPayload(complete())), {
      status: status === 403 ? 'AUTH_FAILED' : 'REVIEW_REQUIRED',
    });
    assert.equal(requests.length, 1, `status ${status}`);
  }
});

test('a lost response or a stalled body is REVIEW_REQUIRED without a second external call', async () => {
  requests = [];
  respond = (req) => req.socket.destroy();
  assert.deepEqual(await client.submit(dverPayload(complete())), { status: 'REVIEW_REQUIRED' });
  assert.equal(requests.length, 1);
  requests = [];
  respond = (_req, res) => {
    res.writeHead(200);
    res.write('{');
  };
  const start = Date.now();
  assert.deepEqual(await client.submit(dverPayload(complete())), { status: 'REVIEW_REQUIRED' });
  assert.ok(Date.now() - start < 15000);
  assert.equal(requests.length, 1);
});

test('a missing Dver key disables submission without sending anything', async () => {
  requests = [];
  const disabled = new DverClient(new ConfigService({ DVER_API_URL: url }));
  assert.throws(
    () => disabled.ensureConfigured(),
    (error) => error.getStatus() === 503,
  );
  await assert.rejects(
    () => disabled.submit(dverPayload(complete())),
    (error) => error.getStatus() === 503,
  );
  assert.equal(requests.length, 0);
});
