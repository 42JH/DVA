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
const billingSecret = process.env.FINAL_TOSS_BILLING_SECRET_KEY;
const authorizations = new Map(), cardRequests = new Map(), cardWaiters = new Map();
const billingPayments = new Map(), billingAttempts = new Map();
const revokedCards = new Set();
let sourceCardClaims;
const sourceCardSettings = {
  DB_HOST: 'monolith-db', DB_PORT: 5432, DB_USER: 'monolith_app', DB_PASSWORD: token, DB_NAME: 'dva_webhook_test',
};
async function claimSourceCard(input) {
  assert.match(input.id, /^[0-9a-f-]{36}$/i);
  if (!sourceCardClaims) {
    const { DatabaseService } = require('/app/dist/database/database.service');
    const { OrderPaymentsRepository } = require('/app/dist/orders/order-payments.repository');
    const { OrderPaymentsService } = require('/app/dist/orders/order-payments.service');
    const { OrdersRepository } = require('/app/dist/orders/orders.repository');
    const { PaymentCardsService } = require('/app/dist/payments/payment-cards.service');
    const config = { get: key => sourceCardSettings[key] }, database = new DatabaseService(config);
    sourceCardClaims = new OrderPaymentsService(database, new OrderPaymentsRepository(null, database, null), null, null,
      new OrdersRepository(), new PaymentCardsService(null, null, null, null, null, config));
  }
  sourceCardSettings.TOSS_BILLING_SECRET_KEY = input.config?.TOSS_BILLING_SECRET_KEY;
  sourceCardSettings.PAYMENT_CARD_ENCRYPTION_KEY = input.config?.PAYMENT_CARD_ENCRYPTION_KEY;
  return sourceCardClaims.claimCardApproval(input.id);
}
async function notifySourcePayments(input) {
  const url = new URL(input.webhook);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.pathname, '/notice');
  const { DatabaseService } = require('/app/dist/database/database.service');
  const { PaymentsRepository } = require('/app/dist/payments/payments.repository');
  const { PaymentsService } = require('/app/dist/payments/payments.service');
  const { PaymentsWorker } = require('/app/dist/payments/payments.worker');
  const { PaymentClient } = require('/app/dist/payments/payment.client');
  const { OrderPaymentsRepository } = require('/app/dist/orders/order-payments.repository');
  const { PaymentCardsRepository } = require('/app/dist/payments/payment-cards.repository');
  const { PaymentCardsService } = require('/app/dist/payments/payment-cards.service');
  const { AuditService } = require('/app/dist/audit/audit.service');
  const { AuditRepository } = require('/app/dist/audit/audit.repository');
  const values = { ...sourceCardSettings, ORDER_PAYMENTS_ENABLED: true,
    PAYMENT_PUBLIC_URL: 'https://payments.example.test/api/payments', PAYMENT_MATTERMOST_WEBHOOK_URL: input.webhook };
  const config = { get: key => values[key] }, database = new DatabaseService(config);
  try {
    const repository = new PaymentsRepository(database);
    const audit = new AuditService(new AuditRepository(database));
    const cards = new PaymentCardsService(database, new PaymentCardsRepository(database), null, null, null, config);
    const payments = new PaymentsService(config, repository, new PaymentClient(config),
      new OrderPaymentsRepository(null, database, audit), cards);
    // Card/hosted approvals and revocation have separate differential cases.
    repository.pendingCardApprovals = repository.pendingApprovals = async () => [];
    payments.revokeDeletedCard = async () => {};
    const worker = new PaymentsWorker(config, payments, repository);
    const current = worker.run();
    assert.equal(worker.run(), current);
    await current;
    await worker.run();
    return { completed: true };
  } finally { await database.onModuleDestroy(); }
}
async function revokeSourceCard(input) {
  const { DatabaseService } = require('/app/dist/database/database.service');
  const { PaymentCardsRepository } = require('/app/dist/payments/payment-cards.repository');
  const { PaymentCardsService } = require('/app/dist/payments/payment-cards.service');
  const { CardProviderClient } = require('/app/dist/payments/card-provider.client');
  const { AuditService } = require('/app/dist/audit/audit.service');
  const { AuditRepository } = require('/app/dist/audit/audit.repository');
  const values = { ...sourceCardSettings, TOSS_BILLING_SECRET_KEY:input.config?.TOSS_BILLING_SECRET_KEY,
    PAYMENT_CARD_ENCRYPTION_KEY:input.config?.PAYMENT_CARD_ENCRYPTION_KEY, PAYMENT_TOSS_BASE_URL:'http://127.0.0.1:8000' };
  const config={get:key=>values[key]}, database=new DatabaseService(config);
  try {
    const cards=new PaymentCardsService(database,new PaymentCardsRepository(database),new CardProviderClient(config),
      new AuditService(new AuditRepository(database)),null,config);
    await cards.revokeDeleted(input.requestId);
    return {completed:true};
  } finally { await database.onModuleDestroy(); }
}
const json = (response, value) => {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
};
createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') return json(response, { status: 'ok' });
    const toss = Boolean(tossSecret && request.url.startsWith('/v1/payments/'));
    const card = Boolean(billingSecret && request.url === '/v1/billing/authorizations/card');
    const billing = Boolean(billingSecret && (request.url.startsWith('/v1/billing/') || request.url.startsWith('/v1/payments/orders/')));
    const authorized = billing ? request.headers.authorization === 'Basic ' + Buffer.from(billingSecret + ':').toString('base64')
      : toss ? request.headers.authorization === 'Basic ' + Buffer.from(tossSecret + ':').toString('base64')
      : request.url === '/parcel' ? request.headers['x-api-key'] === token
      : request.headers.authorization === 'Bearer ' + token;
    if (!authorized) return response.writeHead(401).end();
    if (request.method === 'GET' && request.url === '/__requests') return json(response, requests);
    let text = '';
    for await (const chunk of request) { text += chunk; assert.ok(text.length <= 65536); }
    const body = text ? JSON.parse(text) : null;
    if (request.method === 'POST' && request.url === '/__card-claim' && process.env.FINAL_ORDER_CARD_CLAIMS === 'true') {
      try { return json(response, { claim: await claimSourceCard(body) }); }
      catch (error) {
        response.statusCode = error.getStatus?.() ?? 500;
        if (response.statusCode === 500) process.exitCode = 1;
        return json(response, { error: error.getResponse?.() ?? { code: 'INTERNAL_ERROR', message: String(error), details: [] } });
      }
    }
    if (request.method === 'POST' && request.url === '/__payment-notifications' && process.env.FINAL_ORDER_CARD_CLAIMS === 'true')
      return json(response, await notifySourcePayments(body));
    if (request.method === 'POST' && request.url === '/__card-revocation' && process.env.FINAL_ORDER_CARD_CLAIMS === 'true') {
      try { return json(response,await revokeSourceCard(body)); }
      catch(error) {
        response.statusCode=error.getStatus?.()??500;
        return json(response,{error:error.getResponse?.()??{code:'INTERNAL_ERROR',message:'revocation failed',details:[]}});
      }
    }
    requests.push({ method: request.method, path: request.url, body,
      ...(card ? { registrationKey: request.headers['idempotency-key'] } : {}) });
    if (request.method === 'POST' && request.url === '/__card-release') {
      const release = cardWaiters.get(body.key);
      if (release) { cardWaiters.delete(body.key);release(); }
      return json(response,{released:Boolean(release)});
    }
    if (card && request.method === 'POST') {
      const key=request.headers['idempotency-key'];
      assert.match(key,/^[0-9a-f-]{36}$/);assert.match(body.customerKey,/^[0-9a-f-]{36}$/);
      const count=(cardRequests.get(key)||0)+1;cardRequests.set(key,count);
      if(body.cardNumber.endsWith('0006')) await new Promise(resolve=>cardWaiters.set(key,resolve));
      if(body.cardNumber.endsWith('0001')) {response.statusCode=400;return json(response,{code:'INVALID_CARD_NUMBER'});}
      if(body.cardNumber.endsWith('0002')) {response.statusCode=503;return json(response,{code:'TEMPORARY_FAILURE'});}
      const saved=authorizations.get(key)||{customerKey:body.customerKey,
        billingKey:'fixture-billing-key-'+key,card:{issuerCode:'fixture-issuer-code'}};
      assert.equal(saved.customerKey,body.customerKey);authorizations.set(key,saved);
      if(body.cardNumber.endsWith('0007')&&count===1) {request.socket.destroy();return;}
      if(body.cardNumber.endsWith('0003')) return json(response,{...saved,customerKey:'wrong-customer'});
      if(body.cardNumber.endsWith('0004')) return json(response,{...saved,billingKey:''});
      if(body.cardNumber.endsWith('0005')) return json(response,[]);
      return json(response,saved);
    }
    if (billing && request.method === 'DELETE' && request.url.startsWith('/v1/billing/')) {
      const key=decodeURIComponent(request.url.slice('/v1/billing/'.length));
      if(key.startsWith('revoke-hold-')) await new Promise(resolve=>cardWaiters.set(key,resolve));
      const status=/^revoke-status-([0-9]{3})-/.exec(key);
      if(status) {response.statusCode=Number(status[1]);return json(response,{});}
      if(key.startsWith('revoke-bad-json-')) {response.statusCode=200;return response.end('{');}
      if(revokedCards.has(key)) {response.statusCode=404;return json(response,{});}
      revokedCards.add(key);
      if(key.startsWith('revoke-lost-ack-')) {request.socket.destroy();return;}
      return json(response,{});
    }
    if (billing && !card && request.method === 'POST' && request.url.startsWith('/v1/billing/')) {
      const key = decodeURIComponent(request.url.slice('/v1/billing/'.length));
      assert.match(body.orderId, /^[0-9a-f-]{36}$/i);
      assert.match(body.customerKey, /^[0-9a-f-]{36}$/i);
      assert.equal(body.orderName, 'DVA 택배 결제');
      assert.equal(request.headers['idempotency-key'], body.orderId);
      assert.ok(Number.isInteger(body.amount) && body.amount > 0);
      const count = (billingAttempts.get(body.orderId) || 0) + 1;
      billingAttempts.set(body.orderId, count);
      if (key === 'card-hold') await new Promise(resolve => cardWaiters.set(body.orderId, resolve));
      if (key === 'card-decline') { response.statusCode = 400; return json(response, { code: 'REJECT_CARD_PAYMENT' }); }
      if (key === 'card-unauthorized') { response.statusCode = 401; return json(response, { code: 'UNAUTHORIZED' }); }
      const saved = billingPayments.get(body.orderId) || { status: 'DONE', orderId: body.orderId, totalAmount: body.amount,
        currency: 'KRW', paymentKey: 'card-payment-' + body.orderId, approvedAt: '2030-03-02T00:01:00Z' };
      assert.equal(saved.totalAmount, body.amount);
      billingPayments.set(body.orderId, saved);
      if (key === 'card-unknown' && count === 1) { response.statusCode = 503; return json(response, { code: 'TEMPORARY_FAILURE' }); }
      if (key === 'card-lost-ack' && count === 1) { request.socket.destroy(); return; }
      if (key === 'card-bad-order') return json(response, { ...saved, orderId: 'wrong-order' });
      if (key === 'card-bad-amount') return json(response, { ...saved, totalAmount: body.amount + 1 });
      if (key === 'card-bad-currency') return json(response, { ...saved, currency: 'USD' });
      if (key === 'card-bad-date') return json(response, { ...saved, approvedAt: '2030-03-02' });
      return json(response, saved);
    }
    if (billing && request.method === 'GET' && request.url.startsWith('/v1/payments/orders/')) {
      const saved = billingPayments.get(decodeURIComponent(request.url.slice('/v1/payments/orders/'.length)));
      if (saved) return json(response, saved);
      response.statusCode = 404;
      return json(response, { code: 'NOT_FOUND_PAYMENT' });
    }
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
      if (body.outboundParcels.some(parcel => parcel.clientComment === 'intake-delayed-dver'))
        await new Promise(resolve => setTimeout(resolve, 6000));
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
