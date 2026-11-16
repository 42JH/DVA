require('reflect-metadata');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { validateOrderRead, requestOrderRead, OrderReadError } = require('@dva/events/order-read.cjs');
const { validateEnvironment } = require('../dist/config/environment');
const { OrdersService } = require('../dist/orders/orders.service');
const token = 'order-read-test-only-'.padEnd(48, 't');

test('admin order counts and customer references overlap in their existing read scopes', {timeout:2000}, async t => {
  const referencesModule = require('@dva/events/call-read-references.cjs');
  const referencesStarted = Promise.withResolvers(), countsStarted = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const client = { query: async () => ({ rows: [] }) };
  const eventId = randomUUID();
  t.mock.method(referencesModule,'requestReferences', async (_kind,_url,_token,ids,source,scope) => {
    assert.deepEqual(ids,[12]);
    assert.equal(source,'order');
    assert.equal(scope,eventId);
    referencesStarted.resolve();
    await finish.promise;
    return [{customer_seq:12,organization_name:'existing organization'}];
  });
  const repository = {
    adminList: async owner => { assert.equal(owner,client); return {rows:[{customerSeq:12}],total_count:1}; },
    adminStatusCounts: async owner => {
      assert.equal(owner,client);
      countsStarted.resolve();
      await finish.promise;
      return {all:1,incomplete:0,notPaid:0,paid:0,accepted:0,submissionFailed:0,cancelled:1};
    },
  };
  const config = {CUSTOMER_URL:'http://customer:3001',CONSULTATION_URL:'http://consultation:3004',CUSTOMER_AUTH_TOKEN:token};
  const orders = new OrdersService({transaction:work=>work(client)},repository,{get:key=>config[key]});
  const result = orders.executeAdmin({eventId,source:'customer',eventType:'AdminOrdersReadRequested',
    payload:{query:{limit:10,offset:0},orderAddress:null}});
  try {
    await Promise.all([referencesStarted.promise,countsStarted.promise]);
  } finally {
    finish.resolve();
  }
  const page = await result;
  assert.equal(page.data[0].customerSeq,12);
  assert.equal(page.data[0].organizationName,'existing organization');
  assert.equal(page.total_count,1);
  assert.equal(page.statusCounts.cancelled,1);
});

test('retention references use the independent connection while ordinary order reads are occupied',async()=>{
  const {CallReadReferencesController}=require('../dist/orders/call-read-references.controller');
  const seen=[];
  const controller=new CallReadReferencesController({pool:{query:async()=>{throw Error('all business connections occupied');}},referencePool:{query:async(sql,params)=>{seen.push({sql,params});return{rows:[{customer_seq:2},{customer_seq:7}]};}}},{get:()=>token});
  const event={eventId:randomUUID(),source:'customer',eventType:'CustomerOrderReferencesReadRequested',payload:{ids:[7,2,11]}};
  assert.deepEqual(await controller.query(event),{eventId:event.eventId,status:'processed',payload:[2,7]});
  assert.deepEqual(seen[0].params,[[7,2,11]]);
  for(const invalid of [{...event,source:'consultation'},{...event,payload:{ids:[2,2]}},{...event,payload:{ids:['2']}}])await assert.rejects(controller.query(invalid),e=>e.getStatus()===422);
  assert.equal(seen.length,1);
});

test('paid snapshots reload department names after eligibility checks', async () => {
  const {OrderSubmissionService}=require('../dist/orders/order-submission.service');
  const address={name:'검증 고객',phoneNumber:'01012345678',roadAddress:'검증 도로',
    jibunAddress:'검증 지번',detailAddress:'',dongName:'검증동',postalCode:'01234'};
  const snapshot={paymentMethodType:'credit',pickupRequestedAt:null,totalAmount:7000,creationSource:'AI',
    parcels:[{orderParcelSeq:1,status:'ACTIVE',origin:address,destination:address,
      documentCount:1,smallBoxCount:0,mediumBoxCount:0,bigBoxCount:0,
      otherItemDescription:null,itemPrice:1000,notifiedPrice:7000,originPin:null}]};
  let departmentName='첫 조회 부서',policyReads=0,paidPolicy;
  const repository={detail:async()=>snapshot};
  const audit={recordSuccess:async()=>{}};
  const dver={ensureConfigured:()=>{}};
  const billing={recordCharge:async()=>{}};
  const payments={markPaid:async(_client,_id,_approvedAt,policy)=>{paidPolicy=policy;}};
  const scope={paymentPolicy:async()=>{
    policyReads++;
    return{monthly:true,group:false,organizationSeq:10,departmentSeq:11,
      organizationName:'검증 기업',departmentName};
  }};
  const shipments={blocked:async()=>{departmentName='결제 직전 부서';return false;}};
  const service=new OrderSubmissionService(null,repository,audit,null,dver,null,null,billing,payments,scope,shipments);
  assert.equal(await service.prepareSubmission({},1,2,null,'snapshot-refresh-unit'),true);
  assert.equal(paidPolicy.departmentName,'결제 직전 부서');
  assert.equal(policyReads,2);
});


test('intake accepts an omitted payment method only for eligible company monthly customers', async () => {
  const { OrderIntakeWritesService } = require('../dist/orders/order-intake-writes.service');
  for (const state of [
    { monthly: true, organizationSeq: 1, active: true, accepted: true },
    { monthly: true, organizationSeq: null, active: true, code: 422 },
    { monthly: false, organizationSeq: 1, active: true, code: 422 },
    { monthly: true, organizationSeq: 1, active: false, code: 403 },
  ]) {
    let sealed;
    const call = { enabled: true, intakeVersion: 1, customerSeq: 1, callerPhoneNumber: '01012345678',
      endedAt: null, orderSeq: null, completionPayload: null };
    const scope = { intakeCall: async () => call,
      paymentPolicy: async () => state,
      sealIntake: async (_id, value) => { sealed = value; } };
    const drafts = { lockScope: async () => {}, customer: async () => state.active,
      draft: async () => ({ status: 'READY', parcel: { notifiedPrice: 7000 } }) };
    const service = new OrderIntakeWritesService(null, scope, drafts, null, null, null);
    const pending = service.seal({ query: async () => ({ rows: [{ id: 1 }] }) }, 1, { expectedIntakeVersion: 1 });
    if (state.accepted) {
      assert.deepEqual(await pending, { sealed: true });
      assert.deepEqual(sealed, { expectedIntakeVersion: 1, pickupRequestedAt: null });
    } else {
      await assert.rejects(pending, error => error.getStatus() === state.code);
      assert.equal(sealed, undefined);
    }
  }
});

test('payment replacements bind the selected owner card and preserve requests without a card', async () => {
  const { OrdersRepository } = require('../dist/orders/orders.repository');
  for (const state of [
    { method: 'billing', customer: 2, organization: null, card: 5 },
    { method: 'billing', customer: 2, organization: null, card: null },
    { method: 'groupBilling', customer: 2, organization: 3, card: 6 },
    { method: 'groupBilling', customer: 2, organization: 3, card: null },
    { method: 'groupBilling', customer: 2, organization: null, card: null },
    { method: 'credit', customer: 2, organization: 3, card: null },
  ]) {
    const queries = [], lookups = [];
    const client = { query: async (sql, values) => {
      queries.push({ sql, values });
      return { rows: [{ customerSeq: state.customer, organizationSeq: state.organization, paymentMethodType: state.method }] };
    } };
    const scope = { paymentCard: async (customer, organization) => {
      lookups.push([customer, organization]);
      return state.card;
    } };
    await new OrdersRepository(scope).replaceRequest(client, 1);
    const inserted = queries.find(entry => entry.sql.startsWith('INSERT INTO order_payment_requests'));
    assert.deepEqual(inserted.values, [1, state.card, state.method === 'groupBilling' && state.card === null]);
    assert.deepEqual(lookups, state.method === 'billing' ? [[2, null]] :
      state.method === 'groupBilling' && state.organization !== null ? [[null, 3]] : []);
  }
  let queried = 0;
  const client = { query: async () => { queried++; return { rows: [] }; } };
  await new OrdersRepository({ paymentCard: async () => assert.fail('cancelled order must not read a card') }).replaceRequest(client, 1);
  assert.equal(queried, 2);
});

test('card selection references validate owners and scalar replies with or without a held scope', async t => {
  const { validateWriteReference, requestWriteReference } = require('@dva/events/parcel-draft-write.cjs');
  const event = { eventId: randomUUID(), source: 'order', eventType: 'ParcelDraftWriteReferenceRequested',
    payload: { operation: 'CustomerPaymentCardRead', input: { customerSeq: 1, organizationSeq: null } } };
  validateWriteReference(event);
  for (const input of [{ customerSeq: null, organizationSeq: null }, { customerSeq: 1, organizationSeq: 2 },
    { customerSeq: 0, organizationSeq: null }, { customerSeq: '1', organizationSeq: null },
    { customerSeq: 1, organizationSeq: null, billingKey: 'private' }])
    assert.throws(() => validateWriteReference({ ...event, payload: { ...event.payload, input } }));
  assert.throws(() => validateWriteReference({ ...event, source: 'customer' }));
  let payload = 7;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const incoming = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ eventId: incoming.eventId, status: 'processed', payload }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal(await requestWriteReference(url, token, event), 7);
  payload = null;
  assert.equal(await requestWriteReference(url, token, event, randomUUID()), null);
  for (payload of [0, '7', { paymentCardSeq: 7 }, { billingKey: 'private' }])
    await assert.rejects(requestWriteReference(url, token, event));
  const approval = { ...event, payload: { ...event.payload, operation: 'CustomerApprovalCardRead' } };
  assert.throws(() => requestWriteReference(url, token, approval));
  const card = { paymentCardSeq: 7, providerCustomerKey: randomUUID(), providerEnvironment: 'test', encryptedBillingKey: 'ciphertext' };
  payload = card;
  assert.deepEqual(await requestWriteReference(url, token, approval, randomUUID()), card);
  for (payload of [{ ...card, providerCustomerKey: 'wrong' }, { ...card, providerEnvironment: 'wrong' },
    { ...card, paymentCardSeq: -1 }, { ...card, encryptedBillingKey: 'x'.repeat(8193) },
    { ...card, cardNumber: '1234567812345678' }])
    await assert.rejects(requestWriteReference(url, token, approval, randomUUID()));
  const billing = { ...event, payload: { operation: 'OrderBillingSnapshotRead', input: { organizationSeq: 3, departmentSeq: 4 } } };
  const billingNames = { organizationSeq: 3, departmentSeq: 4, organizationName: '결제 기업', departmentName: '최신 부서' };
  payload = billingNames;
  assert.deepEqual(await requestWriteReference(url, token, billing), billingNames);
  payload = { ...billingNames, organizationSeq: 5 };
  await assert.rejects(requestWriteReference(url, token, billing));
  assert.throws(() => validateWriteReference({ ...billing, payload: { ...billing.payload, input: { organizationSeq: null, departmentSeq: 4 } } }));
});

test('hosted payment confirmation rejects card-bound requests before contacting the provider', async () => {
  const { PaymentsService } = require('../dist/payments/payments.service');
  const client = { query: async () => ({ rows: [] }) };
  const database = { transaction: work => work(client) };
  const repository = { request: async () => ({ paymentCardSeq: 5, amount: 7000,
    order: { retentionExpired: false, status: 'notPaid', totalAmount: 7000 },
    expiresAt: new Date('2099-01-01Z'), approvalStartedAt: new Date(), providerPaymentKey: 'hosted-key' }),
    reserveApproval: async () => true, releaseClaim: async () => {} };
  const provider = { toss: async () => assert.fail('hosted confirmation must not charge a registered card request') };
  const failures=[];
  repository.paymentOrderId=async()=>7;
  const service = new PaymentsService({ get: () => true }, repository, database,
    {recordFailure:async(event,error)=>{failures.push({event,status:error.getStatus()});}}, provider);
  await assert.rejects(service.confirm('card-request', 'card-request', 7000, 'hosted-key', 'card-guard'), error =>
    error.getStatus?.() === 409 && error.getResponse().message === '등록 카드 결제는 기존 거래 결과를 확인해 주세요.');
  assert.equal(failures.length,1);assert.equal(failures[0].event.targetId,7);
  assert.equal(failures[0].event.action,'ORDER_PAYMENT_CONFIRMATION');
  assert.deepEqual(failures[0].event.metadata,{reason:'PAYMENT_REQUEST_FAILED'});
});

test('group billing waits for card approval and stores the current company snapshot', async () => {
  const { OrderSubmissionService } = require('../dist/orders/order-submission.service');
  const address = { name: '검증 고객', phoneNumber: '01012345678', roadAddress: '검증 도로',
    jibunAddress: '검증 지번', detailAddress: '', dongName: '검증동', postalCode: '01234' };
  const snapshot = { paymentMethodType: 'groupBilling', pickupRequestedAt: null, totalAmount: 7000, creationSource: 'AI',
    parcels: [{ orderParcelSeq: 1, status: 'ACTIVE', origin: address, destination: address,
      documentCount: 1, smallBoxCount: 0, mediumBoxCount: 0, bigBoxCount: 0,
      otherItemDescription: null, itemPrice: 1000, notifiedPrice: 7000, originPin: null }] };
  let departmentName = '이전 부서', saved, replacements = 0;
  const events = [], queries = [];
  const policy = () => ({ monthly: false, group: true, organizationSeq: 10, departmentSeq: 11,
    organizationName: '기업 카드', departmentName });
  const repository = { detail: async () => snapshot, replaceRequest: async () => { replacements++; } };
  const payments = { prepareCompanyCard: async (_client, _id, value) => { saved = value; },
    markPaid: async () => assert.fail('group card payment must await approval') };
  const audit = { recordSuccess: async event => { events.push(event); } };
  const dver = { ensureConfigured: () => assert.fail('pending group card payment must not require Dver') };
  const billing = { recordCharge: async () => assert.fail('pending group card payment must not add a charge') };
  const scope = { paymentPolicy: async () => policy() };
  const shipments = { blocked: async () => { departmentName = '접수 직전 부서'; return false; } };
  const service = new OrderSubmissionService(null, repository, audit, null, dver, null, null, billing, payments, scope, shipments);
  assert.equal(await service.prepareSubmission({ query: async sql => { queries.push(sql); } }, 1, 2, 3, 'group-wait'), undefined);
  assert.equal(saved.departmentName, '접수 직전 부서');
  assert.equal(saved.organizationSeq, 10);
  assert.equal(replacements, 1);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /status='notPaid'.*interval '24 hours'/);
  assert.deepEqual(events.map(event => [event.action, event.actorType, event.actorId, event.metadata]),
    [['ORDER_PAYMENT_PENDING', 'ADMIN', 3, { amountAfter: 7000 }]]);
});

test('card approval lookup claims work while customer references are unavailable', async () => {
  const { PaymentsService } = require('../dist/payments/payments.service');
  const id = randomUUID(), orderId = randomUUID();
  let reserved;
  const repository = {
    request: async () => ({ paymentCardSeq: 5, cardPaymentOrderId: orderId, amount: 7000,
      expiresAt: new Date('2000-01-01Z'), approvalStartedAt: new Date(),
      order: { retentionExpired: false, status: 'notPaid', totalAmount: 7000 } }),
    reserveCardApproval: async (_client, request, claim) => { reserved = { request, claim }; },
  };
  const database = { transaction: work => work({ query: async () => ({ rows: [] }) }) };
  const owner = new Proxy({}, { get: () => assert.fail('lookup claims must not read customer state') });
  const service = new PaymentsService(null, repository, database, null, null, null, null, null, owner);
  const claim = await service.claimCardApproval(id);
  assert.equal(claim.done, false);
  assert.equal(claim.lookupOnly, true);
  assert.equal(claim.orderId, orderId);
  assert.equal(claim.amount, 7000);
  assert.equal(claim.card, undefined);
  assert.equal(claim.billingKey, undefined);
  assert.deepEqual(reserved, { request: id, claim: claim.claimId });
  assert.match(claim.claimId, /^[0-9a-f-]{36}$/);
});

test('card approval scope messages bind the request and original owner addresses', async () => {
  const { validateCardApprovalScope } = require('@dva/events/parcel-draft-write.cjs');
  const root = { eventId: randomUUID(), source: 'order', eventType: 'OrderCardApprovalRequested',
    payload: { paymentRequestId: randomUUID(), orderAddress: '10.0.0.2' } };
  validateCardApprovalScope(root, 'order');
  validateCardApprovalScope({ ...root, source: 'customer', payload: { ...root.payload, customerAddress: '10.0.0.3' } }, 'customer');
  for (const changed of [{ ...root, source: 'consultation' }, { ...root, eventType: 'OrderPaid' },
    { ...root, eventId: 'bad' }, { ...root, payload: { ...root.payload, billingKey: 'private' } },
    { ...root, payload: { ...root.payload, paymentRequestId: 1 } },
    { ...root, payload: { ...root.payload, orderAddress: '169.254.169.254' } }])
    assert.throws(() => validateCardApprovalScope(changed, 'order'));
  assert.throws(() => validateCardApprovalScope({ ...root, source: 'customer' }, 'customer'));
});

test('card approval commits one claim before releasing its owner scope and keeps credentials out of acknowledgements', async t => {
  const { PaymentsService } = require('../dist/payments/payments.service');
  const { CardPaymentScopeController } = require('../dist/payments/card-payment-scope.controller');
  const { createCipheriv } = require('node:crypto');
  const encryption = '11'.repeat(32), nonce = Buffer.alloc(12, 1), secret = 'billing-scope-secret';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encryption, 'hex'), nonce);
  cipher.setAAD(Buffer.from('5'));
  const encrypted = Buffer.concat([nonce, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  const id = randomUUID(), orderId = randomUUID(), phases = [], replies = [];
  let service, root, reserved = 0;
  const controller = () => new CardPaymentScopeController(service);
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer ' + token);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      root = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(root.payload.paymentRequestId, id);
      phases.push('customer begin');
      const callback = { ...root, source: 'customer', payload: { ...root.payload, customerAddress: null } };
      await assert.rejects(controller().execute({ ...callback, payload: { ...callback.payload, paymentRequestId: randomUUID() } }),
        error => error.getStatus() === 403);
      replies.push(...await Promise.all([controller().execute(callback), controller().execute(callback)]));
      phases.push('customer commit');
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(replies[0]));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end('{}');
      throw error;
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const values = { CUSTOMER_URL: 'http://127.0.0.1:' + server.address().port, CUSTOMER_AUTH_TOKEN: token,
    TOSS_BILLING_SECRET_KEY: 'test_sk_callback', PAYMENT_CARD_ENCRYPTION_KEY: encryption };
  const config = { get: key => values[key] };
  const database = { transaction: async work => {
    const result = await work({ query: async () => ({ rows: [] }) });
    phases.push('order commit');
    return result;
  } };
  const repository = { request: async () => ({ orderSeq: 1, paymentCardSeq: 5, cardPaymentOrderId: orderId,
    amount: 7000, expiresAt: new Date('2099-01-01Z'), approvalStartedAt: null,
    order: { customerSeq: 2, paymentMethodType: 'billing', retentionExpired: false, status: 'notPaid', totalAmount: 7000 } }),
    reserveCardApproval: async () => { reserved++; phases.push('claim reserved'); } };
  const owner = {
    paymentPolicy: async (_id, scope) => { assert.equal(scope.id, root.eventId); return { group: false }; },
    orderCustomer: async () => ({ active: true }),
    approvalCard: async (customer, organization, scope) => {
      assert.deepEqual([customer, organization, scope], [2, null, { id: root.eventId, address: null }]);
      return { paymentCardSeq: 5, providerCustomerKey: randomUUID(), providerEnvironment: 'test', encryptedBillingKey: encrypted };
    },
    failure: error => { throw error; },
  };
  service = new PaymentsService(config, repository, database, null, null,
    { detail: async () => ({ parcels: [{ status: 'ACTIVE', itemPrice: 1000 }] }) }, null, null, owner);
  const claim = await service.claimCardApproval(id);
  assert.equal(claim.lookupOnly, false);
  assert.equal(claim.billingKey, secret);
  assert.equal(claim.orderId, orderId);
  assert.equal(reserved, 1);
  assert.ok(phases.lastIndexOf('order commit') < phases.indexOf('customer commit'));
  assert.deepEqual(replies, [
    { eventId: root.eventId, status: 'processed', payload: true },
    { eventId: root.eventId, status: 'processed', payload: true },
  ]);
  assert.equal(JSON.stringify([root, replies]).includes(secret), false);
  await assert.rejects(controller().execute({ ...root, source: 'customer', payload: { ...root.payload, customerAddress: null } }),
    error => error.getStatus() === 503);
});

test('card approval rejects an acknowledgement that never prepared the local claim', async t => {
  const { PaymentsService } = require('../dist/payments/payments.service');
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const event = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ eventId: event.eventId, status: 'processed', payload: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const values = { CUSTOMER_URL: 'http://127.0.0.1:' + server.address().port, CUSTOMER_AUTH_TOKEN: token };
  const repository = { request: async () => ({ paymentCardSeq: 5, amount: 7000, expiresAt: new Date('2099-01-01Z'),
    order: { customerSeq: 2, retentionExpired: false, status: 'notPaid', totalAmount: 7000 } }),
    reserveCardApproval: async () => assert.fail('a bare ACK must not create a card claim') };
  const database = { transaction: work => work({ query: async () => ({ rows: [] }) }) };
  const service = new PaymentsService({ get: key => values[key] }, repository, database, null, null, null, null, null,
    { failure: error => { throw error; } });
  await assert.rejects(service.claimCardApproval(randomUUID()), error => error.getStatus() === 503);
});

test('registered card processing preserves approval, lookup, decline and unknown outcomes', async () => {
  const { PaymentsService } = require('../dist/payments/payments.service');
  const orderId = randomUUID(), requestId = randomUUID();
  for (const state of [
    { name: 'approved' }, { name: 'lookup', lookup: true },
    { name: 'declined', status: 400, error: 422, failed: true },
    { name: 'unauthorized', status: 401, error: 502 },
    { name: 'forbidden', status: 403, error: 502 },
    { name: 'timeout', status: 408, error: 502 },
    { name: 'conflict', status: 409, error: 502 },
    { name: 'rate limited', status: 429, error: 502 },
    { name: 'server failure', status: 503, error: 502 },
    { name: 'missing lookup', lookup: true, status: 404, error: 502 },
    { name: 'wrong order', orderId: randomUUID(), error: 502 },
    { name: 'wrong amount', amount: 7001, error: 502 },
    { name: 'wrong currency', currency: 'USD', error: 502 },
    { name: 'invalid date', approvedAt: '2030-01-01', error: 502 },
  ]) {
    const events = [];
    const repository = {
      read: async () => ({ paid: true }),
      recordCardApproval: async (...args) => { events.push(['record', ...args]); },
      failCardApproval: async (...args) => { events.push(['fail', ...args]); },
      releaseClaim: async (...args) => { events.push(['release', ...args]); },
    };
    const response = { status: state.status ?? 200, data: { status: 'DONE', orderId: state.orderId ?? orderId,
      totalAmount: state.amount ?? 7000, currency: state.currency ?? 'KRW', paymentKey: 'provider-card-key',
      approvedAt: state.approvedAt ?? '2030-01-01T00:00:00Z' } };
    const provider = { cardApprove: async (...args) => { events.push(['approve', ...args]); return response; },
      cardLookup: async (...args) => { events.push(['lookup', ...args]); return response; } };
    const failures=[];
    const service = new PaymentsService({ get: () => true }, repository, null,
      {recordFailure:async(event,error)=>{failures.push({event,status:error.getStatus()});}}, provider);
    service.claimCardApproval = async () => ({ done: false, orderId, amount: 7000, lookupOnly: !!state.lookup,
      claimId: 'owned-claim', billingKey: 'billing-key', card: { providerCustomerKey: 'provider-customer' } });
    service.confirmPayment = async (...args) => { events.push(['complete', ...args]); return { status: 'ACCEPTED' }; };
    if (state.error) await assert.rejects(service.processCard(requestId, 'card-unit'), error => error.getStatus() === state.error, state.name);
    else assert.deepEqual(await service.processCard(requestId, 'card-unit'), { paid: true });
    assert.deepEqual(events[0], state.lookup ? ['lookup', orderId] : ['approve', orderId, 7000, 'billing-key', 'provider-customer']);
    assert.deepEqual(events.at(-1), ['release', requestId, 'owned-claim']);
    assert.equal(events.some(event => event[0] === 'fail'), !!state.failed);
    assert.equal(events.some(event => event[0] === 'complete'), !state.error);
    assert.equal(failures.length,state.error?1:0);
    if(state.error){assert.equal(failures[0].status,state.error);assert.equal(failures[0].event.action,'ORDER_CARD_PAYMENT');
      assert.deepEqual(failures[0].event.metadata,{reason:state.error===422?'PAYMENT_DECLINED':'PAYMENT_RESULT_UNKNOWN'});}
    if (!state.error) assert.ok(events.findIndex(event => event[0] === 'record') < events.findIndex(event => event[0] === 'complete'));
  }
});

test('card worker processes four scheduled requests together before normal notification work', async () => {
  const { PaymentsWorker } = require('../dist/payments/payments.worker');
  const started = [], phases = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const payments = {
    processCard: async id => { started.push(id); if (started.length === 4) release(); await gate; phases.push('card'); },
    notifyCompletionOne: async () => { assert.equal(phases.length, 4); phases.push('completion'); return false; },
    notifyOne: async () => { phases.push('notice'); return false; },
  };
  const repository = { pendingCardApprovals: async () => [1, 2, 3, 4].map(id => ({ id })),
    pendingApprovals: async () => { phases.push('hosted'); return []; } };
  await new PaymentsWorker({ get: () => true }, payments, repository).run();
  assert.deepEqual(started, [1, 2, 3, 4]);
  assert.deepEqual(phases, ['card', 'card', 'card', 'card', 'completion', 'notice', 'hosted']);
});

test('home order snapshots validate the owner query, bounded previews and counters', () => {
  const {validateHomeOrdersQuery,validateHomeOrdersResult,requestHomeOrders}=require('@dva/events/call-read-references.cjs');
  const event={eventId:randomUUID(),source:'consultation',eventType:'HomeOrdersReadRequested',
    payload:{observedAt:new Date().toISOString(),consultationAddress:null}};
  validateHomeOrdersQuery(event);
  for(const changed of [{...event,source:'order'},{...event,payload:{...event.payload,observedAt:'invalid'}},
    {...event,payload:{...event.payload,consultationAddress:'169.254.169.254'}},
    {...event,payload:{...event.payload,customerSeq:1}}])
    assert.throws(()=>validateHomeOrdersQuery(changed));
  const value={todayOrderCount:0,notPaid:2,submissionFailed:1,drafts:{data:[],total_count:0,hasNext:false}};
  validateHomeOrdersResult(value);
  for(const changed of [{...value,todayOrderCount:-1},{...value,notPaid:0.5},
    {...value,drafts:{...value.drafts,data:Array(12).fill({})}}])
    assert.throws(()=>validateHomeOrdersResult(changed));
  assert.throws(()=>requestHomeOrders('http://owner/internal',token,event.payload.observedAt,null,'invalid'));
});

test('metrics coalesce scrapes, preserve attention gauges and report database failures', async () => {
  const {ObservabilityService}=require('../dist/observability/observability.service');
  const queries=[],statistics={count:3,failures:1,seconds:0.4,maxSeconds:0.2,connectionWaitSeconds:0.01};
  let probes=0,transactions=0,release;
  const gate=new Promise(resolve=>release=resolve);
  const client={query:async sql=>{
    queries.push(sql);
    return {rows:sql.startsWith('SELECT status')?[{status:'notPaid',count:'2'}]:
      sql.startsWith('SELECT count')?[{count:'1'}]:[]};
  }};
  const database={
    pool:{totalCount:2,idleCount:1,waitingCount:0,query:async()=>{probes++;await gate;}},
    transactionStatistics:statistics,
    transaction:async work=>{transactions++;return work(client);},
  };
  const service=new ObservabilityService(database);
  const pending=service.snapshot();
  assert.equal(service.snapshot(),pending);release();
  const text=await pending;
  assert.equal(probes,1);assert.equal(transactions,1);
  assert.deepEqual(queries.slice(0,2),[
    'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',"SET LOCAL statement_timeout = '2s'",
  ]);
  assert.match(text,/^dva_database_up 1$/m);
  assert.match(text,/^dva_order_metrics_success 1$/m);
  assert.match(text,/^dva_orders_attention\{status="notPaid"\} 2$/m);
  assert.match(text,/^dva_orders_attention\{status="PAID"\} 0$/m);
  assert.match(text,/^dva_orders_stale_submitting 1$/m);
  assert.match(text,/^dva_database_transactions_total 3$/m);
  database.pool.query=async()=>{throw new Error('private connection details');};
  const down=await service.snapshot();
  assert.match(down,/^dva_database_up 0$/m);
  assert.match(down,/^dva_order_metrics_success 0$/m);
  assert.doesNotMatch(down,/dva_orders_attention|dva_orders_stale_submitting|private connection/);
  database.pool.query=async()=>{};
  database.transaction=async()=>{throw new Error('private SQL');};
  const unavailable=await service.snapshot();
  assert.match(unavailable,/^dva_database_up 1$/m);
  assert.match(unavailable,/^dva_order_metrics_success 0$/m);
  assert.doesNotMatch(unavailable,/dva_orders_attention|dva_orders_stale_submitting|private SQL/);
});

test('draft write scopes bind owners, calls, reply versions and authenticated reference queries', async () => {
  const {validateDraftWrite,validateWriteReference,validateCallMutation,requestWriteReference}=require('@dva/events/parcel-draft-write.cjs');
  const input={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteRequested',payload:{
    command:{operation:'ParcelDraftCreated',id:null,adminId:null,callSessionSeq:1,
      input:{clientParcelId:randomUUID(),status:'EDITING',parcel:{}},requestId:'draft-write-test'},
    orderAddress:null,
  }};
  validateDraftWrite(input,'order');
  for(const mutate of [
    e=>e.source='customer',e=>e.payload.actorId=1,e=>e.payload.orderAddress='169.254.169.254',
    e=>e.payload.command.adminId=1,e=>e.payload.command.callSessionSeq=null,
    e=>e.payload.command.input=[],e=>e.payload.command.requestId='',
  ]) {
    const changed=structuredClone(input);mutate(changed);
    assert.throws(()=>validateDraftWrite(changed,'order'));
  }
  const scoped={...input,source:'consultation',payload:{...input.payload,consultationAddress:null,
    call:{callSessionSeq:1,customerSeq:null,intakeVersion:1}}};
  validateDraftWrite(scoped,'consultation');
  for(const call of [null,{callSessionSeq:2,customerSeq:null,intakeVersion:1},{callSessionSeq:1,customerSeq:null,intakeVersion:0}])
    assert.throws(()=>validateDraftWrite({...scoped,payload:{...scoped.payload,call}},'consultation'));
  validateDraftWrite({...scoped,source:'customer',payload:{...scoped.payload,customerAddress:null}},'customer');
  const mutation={callSessionSeq:1,beforeVersion:1,afterVersion:2,customerSeq:2};
  validateCallMutation(mutation);
  for(const changed of [{...mutation,afterVersion:3},{...mutation,customerSeq:0},{...mutation,actorId:1}])
    assert.throws(()=>validateCallMutation(changed));
  const reference={eventId:randomUUID(),source:'order',eventType:'ParcelDraftWriteReferenceRequested',
    payload:{operation:'CustomerRead',input:{id:1}}};
  validateWriteReference(reference);
  assert.throws(()=>validateWriteReference({...reference,source:'customer'}));
  assert.throws(()=>requestWriteReference('http://owner/private',token,reference));
  await assert.rejects(requestWriteReference('http://user:secret@owner/private',token,reference,input.eventId));
});

const event = () => ({ eventId: randomUUID(), source: 'order', eventType: 'OrderReadRequested',
  payload: { command: { operation: 'OrdersListed', id: null, callSessionSeq: 1, query: {} } } });
let server, url, mode;
before(async () => {
  server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer ' + token);
    const parts=[]; for await (const part of request) parts.push(part);
    const input=JSON.parse(Buffer.concat(parts));
    if (mode==='lost') { request.socket.destroy(); return; }
    if (mode==='redirect') { response.writeHead(307, { Location:'/private' }).end(); return; }
    response.setHeader('Content-Type', mode==='html' ? 'text/html' : 'application/json');
    if (mode==='failure') { response.writeHead(403).end(JSON.stringify({ error: { code:'FORBIDDEN', message:'고객 범위 오류', details:[] } })); return; }
    if (mode==='malformed-failure') { response.writeHead(403).end('{}'); return; }
    response.end(mode==='invalid-json' ? '{' : mode==='large' ? ' '.repeat(16*1024*1024+1) : JSON.stringify({
      eventId:mode==='wrong-id' ? randomUUID() : input.eventId, status:mode==='wrong-status' ? 'received' : 'processed',
      payload:mode==='bad-result' ? { data:[], hasNext:'false', total_count:0 } : { data:[], hasNext:false, total_count:0 },
    }));
  });
  await new Promise(resolve=>server.listen(0, '127.0.0.1', resolve));
  url='http://127.0.0.1:'+server.address().port+'/internal/order-read';
});
after(async()=> { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); });

test('validates source, operation, scope and payload before executing a query', () => {
  const valid=event(); validateOrderRead(valid,'order');
  for (const mutate of [e=>e.source='customer',e=>e.eventType='OrderCreated',e=>e.payload.sql='SELECT secret',
    e=>e.payload.command.id=1,e=>e.payload.command.callSessionSeq=0,e=>e.payload.command.operation='OrderDeleted',
    e=>e.payload.command.callSessionSeq=null,e=>e.eventId='bad']) {
    const value=structuredClone(valid);mutate(value);assert.throws(()=>validateOrderRead(value,'order'));
  }
  const scoped={...valid,source:'consultation',payload:{...valid.payload,caller:{phone:'01012345678',endedAt:null,orderSeq:null}}};
  validateOrderRead(scoped,'consultation');
  for (const caller of [null, {}, {...scoped.payload.caller,phone:'010-1234'}, {...scoped.payload.caller,endedAt:'yesterday'}])
    assert.throws(()=>validateOrderRead({...scoped,payload:{...scoped.payload,caller}},'consultation'));
  validateOrderRead({...valid,source:'customer',payload:{...valid.payload,customerSeq:1}},'customer');
  assert.throws(()=>validateOrderRead({...valid,source:'customer',payload:{...valid.payload,customerSeq:null}},'customer'));
});

test('accepts only matching schema-validated acknowledgements and preserves structured domain errors', async () => {
  mode='valid'; assert.deepEqual(await requestOrderRead(url,token,event()),{data:[],hasNext:false,total_count:0});
  for (mode of ['wrong-id','wrong-status','bad-result','html','invalid-json','large','redirect','lost','malformed-failure'])
    await assert.rejects(requestOrderRead(url,token,event()));
  mode='failure';await assert.rejects(requestOrderRead(url,token,event()),error=>error instanceof OrderReadError&&error.status===403&&error.error.message==='고객 범위 오류');
});

test('rejects unexpected origins, credentials and absent production security keys', () => {
  const valid={DB_HOST:'db',DB_USER:'order_app',DB_PASSWORD:'secret',DB_NAME:'order',OPERATIONS_URL:'http://operations:3005',
    DELIVERY_URL:'http://delivery:3003',CUSTOMER_URL:'http://customer:3001',CONSULTATION_URL:'http://consultation:3004',CUSTOMER_AUTH_TOKEN:token};
  assert.equal(validateEnvironment(valid).PORT,3002);
  for (const field of ['OPERATIONS_URL','CUSTOMER_URL','CONSULTATION_URL','DELIVERY_URL']) for (const value of ['', 'http://user:password@service:3000','file:///private','http://service/path'])
    assert.throws(()=>validateEnvironment({...valid,[field]:value}),error=>error.fields.includes(field)&&!error.message.includes('secret'));
  assert.throws(()=>validateEnvironment({...valid,NODE_ENV:'production'}),error=>error.fields.includes('SECURITY_LOG_HMAC_KEY'));
});

test('AI domain errors are not rewritten and local detail establishes its snapshot before the repository', async () => {
  const sql=[];
  const client={query:async text=>{sql.push(text);return{rows:[]};}};
  const database={transaction:work=>work(client)};
  const detail={orderSeq:1,version:4,parcels:[]};
  const repository={detail:async()=>{ assert.deepEqual(sql,['SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY','SELECT 1']);return detail;}};
  const orders=new OrdersService(database,repository,{get:()=>undefined});
  assert.equal(await orders.detail(1,1),detail);
  for (const callId of [undefined,'','0','-1','1,2','2147483648'])
    await assert.rejects(orders.detail(null,1,callId),error=>error.getStatus()===400);
});

test('payment settings retain the original enable flag, test keys, URL and Origin validation', () => {
  const {validateEnvironment}=require('../dist/config/environment');
  const valid={NODE_ENV:'test',DB_HOST:'db',DB_USER:'test',DB_PASSWORD:'test',DB_NAME:'test',
    OPERATIONS_URL:'http://operations:3005',CUSTOMER_AUTH_TOKEN:'a'.repeat(40),
    CUSTOMER_URL:'http://customer:3001',CONSULTATION_URL:'http://consultation:3004',DELIVERY_URL:'http://delivery:3003',
    CORS_ORIGINS:'http://localhost:5173',ORDER_PAYMENTS_ENABLED:'true',PAYMENT_PUBLIC_URL:'http://localhost:5173/api/payments',
    TOSS_TEST_CLIENT_KEY:'test_gck_fixture',TOSS_TEST_SECRET_KEY:'test_gsk_fixture',
    PAYMENT_MATTERMOST_WEBHOOK_URL:'https://mattermost.example.test/hooks/parity'};
  assert.equal(validateEnvironment(valid).ORDER_PAYMENTS_ENABLED,true);
  const cardSettings = validateEnvironment({ ...valid, TOSS_BILLING_SECRET_KEY: 'live_sk_card_fixture', PAYMENT_CARD_ENCRYPTION_KEY: 'a'.repeat(64) });
  assert.equal(cardSettings.TOSS_BILLING_SECRET_KEY, 'live_sk_card_fixture');
  assert.equal(cardSettings.PAYMENT_CARD_ENCRYPTION_KEY, 'a'.repeat(64));
  assert.equal(validateEnvironment({...valid,ORDER_PAYMENTS_ENABLED:'false'}).ORDER_PAYMENTS_ENABLED,false);
  for(const [field,value] of [['ORDER_PAYMENTS_ENABLED','1'],['PAYMENT_PUBLIC_URL','http://localhost:5173/other'],
    ['PAYMENT_PUBLIC_URL','http://other:5173/api/payments'],['PAYMENT_TOSS_BASE_URL','https://other.test'],
    ['TOSS_TEST_CLIENT_KEY','live_gck_fixture'],['TOSS_TEST_SECRET_KEY','live_gsk_fixture'],
    ['TOSS_BILLING_SECRET_KEY','wrong-secret'],['PAYMENT_CARD_ENCRYPTION_KEY','wrong-encryption']])
    assert.throws(()=>validateEnvironment({...valid,[field]:value}),error=>error.fields.includes(field));
});

test('pre-card write receipts replay with legacy false flags while preserving stored data and current flags', async () => {
  const { ParcelDraftWriteScope } = require('../dist/orders/parcel-draft-write-scope.service');
  const { commandHash } = require('@dva/events/call-scope.cjs');
  for (const operation of ['OrderUpdated', 'OrderCreated']) {
    for (const flags of [undefined, { autoCharge: true, cardPaymentFailed: true }]) {
      const command = {
        operation,
        id: operation === 'OrderCreated' ? null : 7,
        adminId: 1,
        callSessionSeq: null,
        input: {},
        requestId: randomUUID(),
        ...(operation === 'OrderCreated' ? { key: randomUUID() } : {}),
      };
      const event = {
        eventId: randomUUID(),
        source: 'customer',
        eventType: 'ParcelDraftWriteRequested',
        payload: { command, call: null },
      };
      const paymentRequest = {
        paymentRequestId: randomUUID(),
        amount: 5000,
        expiresAt: '2099-01-01T00:00:00.000Z',
        notificationStatus: 'PENDING',
        ...flags,
      };
      const order = { orderSeq: 7, paymentRequest };
      const data = operation === 'OrderCreated' ? { result: order, submit: false } : order;
      const stored = {
        source: event.source,
        event_type: event.eventType,
        payload: { requestHash: commandHash(command), result: { data, receipt: null } },
      };
      const original = structuredClone(stored),
        sql = [];
      let flushed = 0;
      const client = {
        query: async (statement) => {
          sql.push(statement);
          return statement.startsWith('SELECT source')
            ? { rows: [stored] }
            : { rows: [], rowCount: 0 };
        },
      };
      const scope = new ParcelDraftWriteScope(
        { transaction: (work) => work(client) },
        {},
        {
          flush: async () => {
            flushed++;
          },
        },
      );
      const result = await scope.run(event, () =>
        scope.transaction(() => assert.fail('replayed write ran again')),
      );
      const actual = operation === 'OrderCreated' ? result.data.result : result.data;
      assert.deepEqual(actual.paymentRequest, {
        ...paymentRequest,
        autoCharge: flags?.autoCharge ?? false,
        cardPaymentFailed: flags?.cardPaymentFailed ?? false,
      });
      assert.deepEqual(stored, original);
      assert.equal(flushed, 1);
      assert.equal(
        sql.some((statement) => /^(UPDATE|DELETE)/.test(statement)),
        false,
      );
    }
  }
});
