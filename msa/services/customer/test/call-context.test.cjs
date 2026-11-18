require('reflect-metadata');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {CallContextClient}=require('../dist/customers/call-context.client');
const {ApiException}=require('../dist/common/errors/api.exception');
const {validateEnvironment}=require('../dist/config/environment');
const token='private-test-customer-token-'.padEnd(48,'a');
const config={OPERATIONS_URL:'http://operations:3005',CUSTOMER_AUTH_TOKEN:token,CONSULTATION_URL:'http://consultation:3004'};
const client=new CallContextClient({get:key=>config[key]});
const input={phoneNumber:'01012345678',call:{providerCallId:'fixed',incomingAt:'2026-10-27T00:00:00Z'}};
const context={callSessionSeq:1,lookupStatus:'UNREGISTERED',customer:null,membership:null,organization:null,department:null,availablePaymentMethods:[],availableUsageTypes:[],personalPins:[],companyPins:[]};
test('sends the original input and verified actor in a correlated event without cookies',async t=>{
 const requestId=randomUUID();
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  assert.equal(url,config.CONSULTATION_URL+'/internal/caller-context');assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers.Authorization,'Bearer '+token);assert.equal(options.headers.Cookie,undefined);
  const event=JSON.parse(options.body);assert.equal(event.source,'customer');assert.equal(event.eventType,'CallerContextRequested');assert.deepEqual(event.payload,{input,actorId:null,requestId});
  return new Response(JSON.stringify({eventId:event.eventId,status:'processed',payload:context}),{headers:{'Content-Type':'application/json'}});
 });
 assert.deepEqual(await client.context(input,null,requestId),context);
});
test('rejects malformed command replies instead of accepting a partial or unrelated success',async t=>{
 for(const change of ['event-id','extra','call-id','missing','json','html']){
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
   const event=JSON.parse(options.body),payload={...context};if(change==='extra')payload.secret='must-not-leak';if(change==='call-id')payload.callSessionSeq=0;if(change==='missing')delete payload.personalPins;
   return new Response(change==='json'?'{':JSON.stringify({eventId:change==='event-id'?randomUUID():event.eventId,status:'processed',payload}),{headers:{'Content-Type':change==='html'?'text/html':'application/json'}});
  });
  await assert.rejects(client.context(input,null,randomUUID()));
 }
});
test('preserves known business conflicts while failing closed on authentication or transport errors',async t=>{
 t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({code:'INVALID_STATE',message:'원본 통화 충돌',details:[]}),{status:409,headers:{'Content-Type':'application/json'}}));
 await assert.rejects(client.context(input,null,randomUUID()),e=>e instanceof ApiException&&e.getStatus()===409&&e.getResponse().message==='원본 통화 충돌');
 t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:401,headers:{'Content-Type':'application/json'}}));await assert.rejects(client.context(input,null,randomUUID()),e=>!(e instanceof ApiException));
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('network unavailable');});await assert.rejects(client.context(input,null,randomUUID()));
});
test('validates consultation configuration and keeps ordinary customer APIs usable without it',()=>{
 const base={DB_HOST:'db',DB_USER:'test',DB_PASSWORD:'test',DB_NAME:'test',OPERATIONS_URL:config.OPERATIONS_URL,CUSTOMER_AUTH_TOKEN:token};
 assert.equal(validateEnvironment(base).CONSULTATION_URL,undefined);
 assert.equal(validateEnvironment({...base,CONSULTATION_URL:config.CONSULTATION_URL}).CONSULTATION_URL,config.CONSULTATION_URL);
 for(const value of [{},'http://user:private@consultation:3004','http://consultation:3004/path','file:///private'])assert.throws(()=>validateEnvironment({...base,CONSULTATION_URL:value}),e=>e.fields.includes('CONSULTATION_URL')&&!e.message.includes('private'));
 for(const value of ['short','x'.repeat(257),'x'.repeat(32)+'\n',{}])assert.throws(()=>validateEnvironment({...base,CONSULTATION_AUTH_TOKEN:value}));
});

test('card reads acquire call locks after local access checks and release them after the owner transaction', async (t) => {
  const { CardCallScopes } = require('../dist/payments/card-call-scopes.service');
  const trace = [],
    wire = [],
    db = { query: async () => ({ rows: [] }) };
  let transactionFinished = false,
    rootEvent;
  const scopes = new CardCallScopes(
    {
      transaction: async (work) => {
        trace.push('begin');
        try {
          return await work(db);
        } finally {
          trace.push('commit-or-rollback');
          transactionFinished = true;
        }
      },
    },
    { get: (key) => config[key] },
  );
  const caller = { phone: '01012345678', customerSeq: 1, endedAt: null };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.signal, null);
    const event = JSON.parse(options.body);
    wire.push(event);
    if (String(url).endsWith('/internal/card-call-scope')) {
      trace.push('call-scope');
      rootEvent = event;
      const callback = {
        ...event,
        source: 'consultation',
        payload: { consultationAddress: '10.0.0.9' },
      };
      const replies = await Promise.all([scopes.execute(callback), scopes.execute(callback)]);
      assert.deepEqual(replies[1], replies[0]);
      assert.equal(transactionFinished, true);
      trace.push('call-release');
      return Response.json({ eventId: event.eventId, status: 'processed' });
    }
    assert.equal(new URL(url).hostname, '10.0.0.9');
    trace.push('caller');
    assert.equal(transactionFinished, false);
    return Response.json({ eventId: event.eventId, status: 'processed', payload: caller });
  });
  const privateResult = { encryptedBillingKey: 'local-only', paymentCardSeq: 7 };
  assert.equal(
    await scopes.transaction(null, async (client) => {
      assert.equal(client, db);
      trace.push('owner-check');
      assert.deepEqual(await scopes.caller(1), caller);
      trace.push('local-card');
      return privateResult;
    }),
    privateResult,
  );
  assert.deepEqual(trace, [
    'begin',
    'owner-check',
    'call-scope',
    'caller',
    'local-card',
    'commit-or-rollback',
    'call-release',
  ]);
  assert.equal(JSON.stringify(wire).includes('local-only'), false);
  assert.deepEqual(Object.keys(wire[0].payload), ['customerAddress']);
  assert.deepEqual(Object.keys(wire[1].payload).sort(), ['callSessionSeq', 'scopeId']);
  await assert.rejects(
    scopes.execute({
      ...rootEvent,
      source: 'consultation',
      payload: { consultationAddress: '10.0.0.9' },
    }),
    (error) => error.getStatus() === 503,
  );
  await assert.rejects(scopes.caller(1), (error) => error.getStatus() === 503);
});

test('card access preserves missing and inactive owners before headers or unavailable consultation', async (t) => {
  const { CardCallScopes } = require('../dist/payments/card-call-scopes.service');
  const { PaymentCardsService } = require('../dist/payments/payment-cards.service');
  const database = { transaction: (work) => work({}) };
  const scopes = new CardCallScopes(database, { get: () => undefined });
  let owner;
  const repository = { owner: async () => owner, active: async () => null };
  const cards = new PaymentCardsService(repository, scopes);
  t.mock.method(globalThis, 'fetch', () =>
    assert.fail('owner or header failure reached consultation'),
  );
  for (const [value, status] of [
    [undefined, 404],
    [{ status: 'WITHDRAWN' }, 409],
    [{ status: 'ACTIVE' }, 400],
  ]) {
    owner = value;
    await assert.rejects(
      cards.read('CUSTOMER', 1, null, 'invalid'),
      (error) => error.getStatus() === status,
    );
  }
  owner = { status: 'ACTIVE' };
  assert.equal(await cards.read('CUSTOMER', 1, 1, 'invalid'), null);
  await assert.rejects(cards.read('CUSTOMER', 1, null, '1'), (error) => error.getStatus() === 503);
});

test('card scope failures roll back local work and reject empty acknowledgements or lost replies', async (t) => {
  const { CardCallScopes } = require('../dist/payments/card-call-scopes.service');
  let rolledBack = 0;
  const scopes = new CardCallScopes(
    {
      transaction: async (work) => {
        try {
          return await work({});
        } catch (error) {
          rolledBack++;
          throw error;
        }
      },
    },
    { get: (key) => config[key] },
  );
  for (const mode of ['empty', 'network', 'caller-error', 'lost-ack', 'local-error']) {
    const sqlError = new Error('database failure');
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      const event = JSON.parse(options.body);
      if (String(url).endsWith('/internal/card-call-scope')) {
        if (mode === 'network') throw new Error('offline');
        if (mode !== 'empty')
          await scopes.execute({
            ...event,
            source: 'consultation',
            payload: { consultationAddress: null },
          });
        if (mode === 'lost-ack') throw new Error('lost root acknowledgement');
        return Response.json({ eventId: event.eventId, status: 'processed' });
      }
      if (mode === 'caller-error')
        return Response.json(
          {
            error: {
              code: 'INVALID_STATE',
              message: '종료된 통화에서는 고객 기본 주소를 수정할 수 없습니다.',
              details: [],
            },
          },
          { status: 409 },
        );
      return Response.json({
        eventId: event.eventId,
        status: 'processed',
        payload: { phone: '01012345678', customerSeq: 1, endedAt: null },
      });
    });
    await assert.rejects(
      scopes.transaction(null, async () => {
        await scopes.caller(1);
        if (mode === 'local-error') throw sqlError;
      }),
      (error) =>
        mode === 'local-error'
          ? error === sqlError
          : error instanceof ApiException &&
            error.getStatus() === (mode === 'caller-error' ? 409 : 503),
    );
  }
  assert.equal(rolledBack, 4);
});

test('card removal keeps the owner transaction and emits one audit per removed card', async () => {
  const { PaymentCardsService } = require('../dist/payments/payment-cards.service');
  const calls = [],
    audits = [],
    client = {};
  const repository = {
    owner: async () => ({ status: 'ACTIVE', phoneNumber: '01012345678' }),
    remove: async (tx, kind, ids, except) => {
      assert.equal(tx, client);
      assert.equal(kind, 'CUSTOMER');
      assert.deepEqual(ids, [1]);
      assert.equal(except, undefined);
      return [{ id: 7 }, { id: 8 }];
    },
  };
  const scope = {
    transaction: (actor, work) => {
      calls.push(actor);
      return work(client);
    },
    caller: async (id) => {
      assert.equal(id, 3);
      return { phone: '01012345678', customerSeq: 1 };
    },
  };
  const cards = new PaymentCardsService(repository, scope, {
    recordSuccess: async (event, tx) => {
      assert.equal(tx, client);
      audits.push(event);
    },
  });
  for (const actor of [1, null]) {
    const requestId = randomUUID();
    await cards.remove('CUSTOMER', 1, actor, requestId, '3');
    assert.deepEqual(
      audits.splice(0),
      [7, 8].map((targetId) => ({
        actorId: actor,
        actorType: actor === null ? 'AI' : 'ADMIN',
        targetType: 'PAYMENT_CARD',
        targetId,
        action: 'PAYMENT_CARD_DELETED',
        requestId,
      })),
    );
  }
  assert.deepEqual(calls, [1, null]);
});

test('card registration preserves source provider input, HMAC, encrypted storage and transaction boundaries', async () => {
  const { PaymentCardsService } = require('../dist/payments/payment-cards.service');
  const { createHmac, createDecipheriv } = require('node:crypto');
  const encryptionKey = '01'.repeat(32),
    key = randomUUID(),
    requestId = randomUUID();
  const input = {
    cardNumber: '4000000000001234',
    expirationYear: 2099,
    expirationMonth: 12,
    customerIdentityNumber: '900101',
    cardPassword: '01',
    customerName: '카드 명의',
  };
  const settings = {
    TOSS_BILLING_SECRET_KEY: 'test_sk_card_fixture',
    PAYMENT_CARD_ENCRYPTION_KEY: encryptionKey,
  };
  const sql = [],
    scopeModes = [],
    audits = [],
    client = {
      query: async (statement) => {
        sql.push(statement);
      },
    };
  let active = false,
    transactions = 0,
    candidate,
    providerCalls = 0;
  const database = {
    transaction: async (work) => {
      assert.equal(active, false);
      active = true;
      transactions++;
      try {
        return await work(client);
      } finally {
        active = false;
      }
    },
  };
  const scope = {
    transaction: (actor, work, registration) => {
      assert.equal(actor, 1);
      scopeModes.push(registration);
      return database.transaction(work);
    },
  };
  const repository = {
    owner: async () => ({ status: 'ACTIVE', phoneNumber: '01012345678' }),
    registration: async () => candidate,
    create: async (tx, kind, id, registrationKey, hash, environment, year, month) => {
      assert.equal(tx, client);
      assert.equal(active, true);
      assert.deepEqual(
        [kind, id, registrationKey, environment, year, month],
        ['CUSTOMER', 1, key, 'test', 2099, 12],
      );
      assert.equal(
        hash,
        createHmac('sha256', Buffer.from(encryptionKey, 'hex'))
          .update(
            JSON.stringify([
              kind,
              id,
              input.cardNumber,
              year,
              month,
              input.customerIdentityNumber,
              input.cardPassword,
              input.customerName,
            ]),
          )
          .digest('hex'),
      );
      candidate = {
        paymentCardSeq: 7,
        status: 'REGISTERING',
        requestHash: hash,
        providerCustomerKey: randomUUID(),
        providerEnvironment: environment,
        expirationYear: year,
        expirationMonth: month,
        deletedAt: null,
        claimedUntil: null,
      };
      return candidate;
    },
    remove: async (tx, kind, ids, except) => {
      assert.equal(tx, client);
      assert.equal(active, true);
      assert.deepEqual([kind, ids, except], ['CUSTOMER', [1], 7]);
      return [{ id: 3 }];
    },
    activate: async (tx, id, encrypted, issuer, mask) => {
      assert.equal(tx, client);
      assert.equal(active, true);
      assert.equal(id, 7);
      candidate = {
        ...candidate,
        status: 'ACTIVE',
        encryptedBillingKey: encrypted,
        issuerCode: issuer,
        maskedNumber: mask,
      };
      return candidate;
    },
  };
  const provider = {
    register: async (customerKey, registrationKey, body) => {
      assert.equal(active, false);
      providerCalls++;
      assert.equal(customerKey, candidate.providerCustomerKey);
      assert.equal(registrationKey, key);
      assert.deepEqual(body, input);
      return {
        status: 200,
        data: {
          customerKey,
          billingKey: 'fixture-billing-key',
          card: { issuerCode: '12345678901234' },
        },
      };
    },
  };
  const cards = new PaymentCardsService(
    repository,
    scope,
    {
      recordSuccess: async (event) => {
        assert.equal(active, true);
        audits.push(event);
      },
    },
    database,
    provider,
    { get: (name) => settings[name] },
  );
  const result = await cards.register('CUSTOMER', 1, input, key.toUpperCase(), 1, requestId);
  assert.deepEqual(result, {
    paymentCardSeq: 7,
    issuerCode: '1234567890',
    maskedNumber: '************1234',
    expirationYear: 2099,
    expirationMonth: 12,
    active: true,
  });
  assert.equal(transactions, 2);
  assert.deepEqual(scopeModes, [true]);
  assert.equal(providerCalls, 1);
  const bytes = Buffer.from(candidate.encryptedBillingKey, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(encryptionKey, 'hex'),
    bytes.subarray(0, 12),
  );
  decipher.setAAD(Buffer.from('7'));
  decipher.setAuthTag(bytes.subarray(-16));
  assert.equal(
    Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(),
    'fixture-billing-key',
  );
  assert.deepEqual(
    audits.map((event) => [event.action, event.targetId]),
    [
      ['PAYMENT_CARD_DELETED', 3],
      ['PAYMENT_CARD_REGISTERED', 7],
    ],
  );
  assert.ok(
    audits.every((event) => event.requestId === requestId && event.targetType === 'PAYMENT_CARD'),
  );
  assert.deepEqual(await cards.register('CUSTOMER', 1, input, key, 1, randomUUID()), result);
  assert.equal(providerCalls, 1);
  assert.equal(audits.length, 2);
  assert.deepEqual(sql, ["SET LOCAL lock_timeout='2s'", "SET LOCAL lock_timeout='2s'"]);
});

test('card provider keeps the source request fields, deadline and bounded response errors', async (t) => {
  const { CardProviderClient } = require('../dist/payments/card-provider.client');
  const settings = {
    TOSS_BILLING_SECRET_KEY: 'test_sk_card_fixture',
    PAYMENT_TOSS_BASE_URL: 'http://127.0.0.1:8000',
  };
  const provider = new CardProviderClient({ get: (name) => settings[name] });
  const input = {
    cardNumber: '4000000000001234',
    expirationYear: 2099,
    expirationMonth: 1,
    customerIdentityNumber: '900101',
    cardPassword: '01',
    customerName: '',
  };
  const customerKey = randomUUID(),
    registrationKey = randomUUID(),
    timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  let response = () => Response.json({ customerKey, billingKey: 'fixture-key' });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, settings.PAYMENT_TOSS_BASE_URL + '/v1/billing/authorizations/card');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(
      options.headers.Authorization,
      'Basic ' + Buffer.from(settings.TOSS_BILLING_SECRET_KEY + ':').toString('base64'),
    );
    assert.equal(options.headers['Idempotency-Key'], registrationKey);
    assert.equal(options.headers.Cookie, undefined);
    assert.deepEqual(JSON.parse(options.body), {
      customerKey,
      cardNumber: input.cardNumber,
      cardExpirationYear: '99',
      cardExpirationMonth: '01',
      customerIdentityNumber: '900101',
      cardPassword: '01',
    });
    return response();
  });
  assert.deepEqual(await provider.register(customerKey, registrationKey, input), {
    status: 200,
    data: { customerKey, billingKey: 'fixture-key' },
  });
  for (const invalid of [
    () => Response.json([]),
    () => new Response('{'),
    () => new Response('x'.repeat(65537)),
    () => {
      throw Error('network unavailable');
    },
  ]) {
    response = invalid;
    await assert.rejects(
      provider.register(customerKey, registrationKey, input),
      (error) => error.getStatus() === 502 && error.getResponse().code === 'PAYMENT_RESULT_UNKNOWN',
    );
  }
  assert.ok(timeouts.every((ms) => ms === 65000));
  settings.TOSS_BILLING_SECRET_KEY = undefined;
  await assert.rejects(
    provider.register(customerKey, registrationKey, input),
    (error) => error.getStatus() === 503,
  );
});

test('card revocation confirms PG removal before clearing the stored key and auditing', async t => {
  const { createCipheriv, randomBytes } = require('node:crypto');
  const { PaymentCardsService } = require('../dist/payments/payment-cards.service');
  const settings = { TOSS_BILLING_SECRET_KEY:'test_sk_revoke', PAYMENT_CARD_ENCRYPTION_KEY:'11'.repeat(32),
    ORDER_URL:'http://order:3002', CUSTOMER_AUTH_TOKEN:token };
  const nonce=randomBytes(12), cipher=createCipheriv('aes-256-gcm',Buffer.from(settings.PAYMENT_CARD_ENCRYPTION_KEY,'hex'),nonce);
  cipher.setAAD(Buffer.from('7'));
  const card={paymentCardSeq:7,providerEnvironment:'test',encryptedBillingKey:
    Buffer.concat([nonce,cipher.update('revocation-key','utf8'),cipher.final(),cipher.getAuthTag()]).toString('base64')};
  let events=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(String(url),'http://order:3002/internal/parcel-draft-write/reference');
    assert.equal(options.headers.Authorization,'Bearer '+token);
    const event=JSON.parse(options.body);
    assert.equal(event.source,'customer');
    assert.deepEqual(event.payload,{operation:'OrderPendingCardApprovalRead',input:{id:7}});
    events.push('pending');
    return Response.json({eventId:event.eventId,status:'processed',payload:false});
  });
  for(const status of [200,404,400,503]) {
    events=[];
    const repository={claimRevocation:async (environment,pending)=>{
      assert.equal(environment,'test');assert.equal(await pending(7),false);events.push('claim committed');return card;
    },revoked:async (client,id)=>{assert.equal(id,7);events.push('key cleared');}};
    const provider={revoke:async key=>{assert.equal(key,'revocation-key');events.push('PG outside claim');return {status};}};
    const database={transaction:async work=>{events.push('begin completion');return work({});}};
    const audit={recordSuccess:async value=>{
      assert.deepEqual(value,{actorId:null,actorType:'SYSTEM',targetType:'PAYMENT_CARD',targetId:7,
        action:'PAYMENT_CARD_REVOKED',requestId:'revoke-request'});events.push('audit');
    }};
    const service=new PaymentCardsService(repository,null,audit,database,provider,{get:key=>settings[key]});
    await service.revokeDeleted('revoke-request');
    assert.deepEqual(events,['pending','claim committed','PG outside claim',...([200,404].includes(status)?['begin completion','key cleared','audit']:[])]);
  }
  events=[];
  settings.PAYMENT_CARD_ENCRYPTION_KEY=undefined;
  await new PaymentCardsService(null,null,null,null,null,{get:key=>settings[key]}).revokeDeleted('disabled');
  assert.deepEqual(events,[]);
});

test('card revocation provider sends an encoded DELETE without body or registration headers', async t => {
  const { CardProviderClient } = require('../dist/payments/card-provider.client');
  const provider=new CardProviderClient({get:key=>({TOSS_BILLING_SECRET_KEY:'test_sk_revoke',PAYMENT_TOSS_BASE_URL:'http://127.0.0.1:8000'})[key]});
  let status=200;
  t.mock.method(AbortSignal,'timeout',ms=>{assert.equal(ms,65000);return new AbortController().signal;});
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    assert.equal(url,'http://127.0.0.1:8000/v1/billing/'+encodeURIComponent('key /한'));
    assert.equal(options.method,'DELETE');assert.equal(options.redirect,'error');
    assert.deepEqual(options.headers,{Authorization:'Basic '+Buffer.from('test_sk_revoke:').toString('base64')});
    assert.equal(options.body,undefined);
    return new Response('',{status});
  });
  for(status of [200,404,503]) assert.deepEqual(await provider.revoke('key /한'),{status,data:{}});
});

test('card revocation worker retains enablement, five-second scheduling, single flight and shutdown', async t => {
  const { PaymentCardRevocationWorker } = require('../dist/payments/payment-card-revocation.worker');
  const settings={NODE_ENV:'production',ORDER_PAYMENTS_ENABLED:true};
  let release,tick,calls=0,cleared=false;
  const timer={unref(){}};
  t.mock.method(globalThis,'setTimeout',(callback,ms)=>{assert.equal(ms,5000);tick=callback;return timer;});
  t.mock.method(globalThis,'clearTimeout',value=>{assert.equal(value,timer);cleared=true;});
  const worker=new PaymentCardRevocationWorker({get:key=>settings[key]},{revokeDeleted:async id=>{
    assert.match(id,/^[0-9a-f-]{36}$/i);calls++;await new Promise(resolve=>{release=resolve;});
  }});
  worker.onApplicationBootstrap();
  const current=worker.run();assert.equal(worker.run(),current);assert.equal(calls,1);
  let stopped=false;const stopping=worker.onModuleDestroy().then(()=>{stopped=true;});
  await Promise.resolve();assert.equal(stopped,false);assert.equal(cleared,true);
  release();await current;await stopping;tick();assert.equal(calls,1);
  settings.ORDER_PAYMENTS_ENABLED=false;await worker.run();assert.equal(calls,1);
});

test('card settings retain source test-only overrides and redact invalid credential values', () => {
  const base = {
    NODE_ENV: 'test',
    DB_HOST: 'db',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    DB_NAME: 'test',
    OPERATIONS_URL: config.OPERATIONS_URL,
    CUSTOMER_AUTH_TOKEN: token,
  };
  const valid = {
    ...base,
    TOSS_BILLING_SECRET_KEY: 'live_sk_fixture',
    PAYMENT_CARD_ENCRYPTION_KEY: 'AB'.repeat(32),
    PAYMENT_TOSS_BASE_URL: 'http://127.0.0.1:8000',
  };
  assert.equal(validateEnvironment(valid).TOSS_BILLING_SECRET_KEY, valid.TOSS_BILLING_SECRET_KEY);
  assert.equal(validateEnvironment(base).PAYMENT_TOSS_BASE_URL, 'https://api.tosspayments.com');
  assert.equal(validateEnvironment(base).ORDER_PAYMENTS_ENABLED, false);
  assert.equal(validateEnvironment({ ...base, ORDER_PAYMENTS_ENABLED:'true' }).ORDER_PAYMENTS_ENABLED, true);
  for (const [field, value] of [
    ['TOSS_BILLING_SECRET_KEY', 'secret-invalid-value'],
    ['PAYMENT_CARD_ENCRYPTION_KEY', 'secret-invalid-value'],
    ['PAYMENT_TOSS_BASE_URL', 'http://remote.invalid'],
    ['PAYMENT_TOSS_BASE_URL', 'https://api.tosspayments.com/path'],
    ['PAYMENT_TOSS_BASE_URL', 'http://user:secret-invalid-value@127.0.0.1:8000'],
    ['ORDER_PAYMENTS_ENABLED', 'secret-invalid-value'],
  ])
    assert.throws(
      () => validateEnvironment({ ...base, [field]: value }),
      (error) => error.fields.includes(field) && !error.message.includes('secret-invalid-value'),
    );
  assert.throws(
    () =>
      validateEnvironment({
        ...valid,
        NODE_ENV: 'production',
        SECURITY_LOG_HMAC_KEY: '01'.repeat(32),
      }),
    (error) => error.fields.includes('PAYMENT_TOSS_BASE_URL'),
  );
});

test('registration scopes forward the original call lock policy with transient routing fields', async (t) => {
  const { CardCallScopes } = require('../dist/payments/card-call-scopes.service');
  const scopes = new CardCallScopes(
    { transaction: (work) => work({}) },
    { get: (key) => config[key] },
  );
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const event = JSON.parse(options.body);
    requests.push(event);
    if (String(url).endsWith('/internal/card-call-scope')) {
      assert.deepEqual(event.payload, { customerAddress: null, registration: true });
      await scopes.execute({
        ...event,
        source: 'consultation',
        payload: { consultationAddress: null },
      });
      return Response.json({ eventId: event.eventId, status: 'processed' });
    }
    return Response.json({
      eventId: event.eventId,
      status: 'processed',
      payload: { phone: '01012345678', customerSeq: 1, endedAt: null },
    });
  });
  await scopes.transaction(
    null,
    async () => {
      await scopes.caller(1);
    },
    true,
  );
  assert.deepEqual(Object.keys(requests[1].payload).sort(), ['callSessionSeq', 'scopeId']);
});
