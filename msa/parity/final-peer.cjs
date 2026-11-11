// Disposable AI/Dver responses using the same contracts as the original integration fixtures.
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createHash } = require('node:crypto');
assert.equal(process.env.NODE_ENV, 'test');
const token = process.env.FINAL_SERVICE_TOKEN;
assert.ok(token?.length >= 32);
const requests = [];
const tossSecret = process.env.FINAL_TOSS_TEST_SECRET_KEY;
const payments = new Map();
const json = (response, value) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
};
createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return json(response, { status: 'ok' });
    const toss = Boolean(tossSecret && request.url.startsWith('/v1/payments/'));
    const authorized = toss ? request.headers.authorization === 'Basic ' + Buffer.from(tossSecret + ':').toString('base64')
      : request.url === '/parcel' ? request.headers['x-api-key'] === token
      : request.headers.authorization === 'Bearer ' + token;
    if (!authorized) return response.writeHead(401).end();
    if (request.method === 'GET' && request.url === '/__requests') return json(response, requests);
    let text = '';
    for await (const chunk of request) { text += chunk; assert.ok(text.length <= 65536); }
    const body = text ? JSON.parse(text) : null;
    requests.push({ method: request.method, path: request.url, body });
    if (toss && request.method === 'POST' && request.url === '/v1/payments/confirm') {
      const { orderId, amount, paymentKey } = body;
      assert.equal(request.headers['idempotency-key'],createHash('sha256')
        .update(JSON.stringify([orderId,amount,paymentKey])).digest('hex'));
      if(paymentKey==='reject-card') {
        response.statusCode=400;
        return json(response,{code:'REJECT_CARD_PAYMENT'});
      }
      const payment={orderId,totalAmount:amount,paymentKey,currency:'KRW',status:'DONE',
        approvedAt:paymentKey==='approve-legacy-credit'?'2030-02-28T15:00:00Z':'2030-03-01T09:01:00Z'};
      payments.set(paymentKey,payment);
      if(paymentKey==='approve-unknown') {
        response.statusCode=502;
        return json(response,{code:'RESULT_UNAVAILABLE'});
      }
      return json(response,payment);
    }
    if (toss && request.method === 'GET') {
      const payment=payments.get(decodeURIComponent(request.url.slice('/v1/payments/'.length)));
      if(payment) return json(response,payment);
      response.statusCode=404;
      return json(response,{code:'NOT_FOUND_PAYMENT'});
    }
    if (request.method === 'GET' && request.url === '/internal/persona/options')
      return json(response, { voices: [{ id: 'test-voice', label: '검증 음성' }],
        speakingRate: { min: 0.8, max: 1.2 }, turnWaitLevels: ['SHORT', 'NORMAL', 'LONG'] });
    if (request.method === 'POST' && request.url === '/parcel') {
      assert.ok(Array.isArray(body.outboundParcels) && body.outboundParcels.length > 0);
      return json(response, { ok: true, parcelNo: 'TEST0052',
        receivedAt: tossSecret ? '2030-03-02T00:01:00Z' : new Date().toISOString() });
    }
    if (request.method === 'POST' && ['/internal/persona/refresh', '/internal/faqs/refresh'].includes(request.url))
      return response.writeHead(202).end();
    response.writeHead(404).end();
  } catch {
    response.writeHead(500).end();
    process.exitCode = 1;
  }
}).listen(8000, '0.0.0.0');
