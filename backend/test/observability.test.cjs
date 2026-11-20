require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
const { JsonLogger, logRecord, logContext } = require('../dist/observability/json-logger');
const { DatabaseService } = require('../dist/database/database.service');
const { ObservabilityService } = require('../dist/observability/observability.service');
const { recordHttp, httpMetrics } = require('../dist/observability/http-metrics');
const { requestContext } = require('../dist/common/http/request-context');
const { authenticationRecord } = require('../dist/observability/security-events');
const securityKey = 'ab'.repeat(32);
const securityRequest = (extra = {}) => ({
  method: 'POST',
  path: '/api/auth/login',
  requestId: randomUUID(),
  body: { loginId: 'Operator01', password: 'PRIVATE-password' },
  socket: { remoteAddress: '::ffff:192.0.2.1' },
  get: () => undefined,
  ...extra,
});

test('authentication pseudonyms link identical claims, preserve case and separate source and key domains', () => {
  const request = securityRequest();
  const failed = authenticationRecord(request, 401, securityKey, 0);
  const success = authenticationRecord(securityRequest(), 200, securityKey, 0);
  assert.equal(failed.reason, 'invalid_credentials');
  assert.equal(success.event, 'authentication_success');
  assert.equal(failed.accountKey, success.accountKey);
  assert.equal(failed.sourceKey, success.sourceKey);
  assert.notEqual(
    failed.accountKey,
    authenticationRecord(securityRequest({ body: { loginId: 'operator01' } }), 401, securityKey, 0)
      .accountKey,
  );
  assert.notEqual(
    failed.accountKey,
    authenticationRecord(request, 401, 'cd'.repeat(32), 0).accountKey,
  );
  assert.notEqual(
    failed.accountKey,
    authenticationRecord(securityRequest({ body: { loginId: '1920021' } }), 401, securityKey, 0)
      .sourceKey,
  );
  for (const value of [failed.accountKey, failed.sourceKey]) assert.match(value, /^[a-f0-9]{64}$/);
  const text = JSON.stringify(failed);
  for (const secret of [securityKey, 'Operator01', '192.0.2.1', 'PRIVATE-password'])
    assert.ok(!text.includes(secret));
});

test('authentication logs use the existing trusted proxy tail and ignore forged direct-peer headers', () => {
  const request = securityRequest({ get: () => '198.51.100.99, 203.0.113.2, 10.0.0.4' });
  const direct = authenticationRecord(securityRequest(), 401, securityKey, 0);
  assert.equal(authenticationRecord(request, 401, securityKey, 0).sourceKey, direct.sourceKey);
  const trusted = authenticationRecord(request, 401, securityKey, 2);
  assert.equal(
    trusted.sourceKey,
    authenticationRecord(
      securityRequest({ socket: { remoteAddress: '203.0.113.2' } }),
      401,
      securityKey,
      0,
    ).sourceKey,
  );
  assert.equal(
    authenticationRecord(securityRequest({ get: () => 'garbage, 10.0.0.4' }), 401, securityKey, 2)
      .sourceKey,
    direct.sourceKey,
  );
  assert.equal(
    authenticationRecord(securityRequest({ socket: {} }), 401, securityKey, 0).sourceKey,
    undefined,
  );
});

test('authentication failure types distinguish credentials, throttling, account policy and invalid input', () => {
  for (const [status, code, reason] of [
    [401, 'UNAUTHORIZED', 'invalid_credentials'],
    [429, 'RATE_LIMITED', 'rate_limited'],
    [403, 'ACCOUNT_PENDING', 'account_pending'],
    [403, 'ACCOUNT_INACTIVE', 'account_inactive'],
    [403, 'FORBIDDEN', 'access_denied'],
    [400, 'INVALID_REQUEST', 'invalid_input'],
  ]) {
    const record = authenticationRecord(
      securityRequest({ securityErrorCode: code }),
      status,
      securityKey,
      0,
    );
    assert.equal(record.reason, reason);
    if (reason === 'invalid_input') assert.equal(record.accountKey, undefined);
  }
  for (const loginId of ['', 'x'.repeat(21), '한글', 'user\nsecret', {}, null])
    assert.equal(
      authenticationRecord(securityRequest({ body: { loginId } }), 401, securityKey, 0).accountKey,
      undefined,
    );
  assert.equal(authenticationRecord(securityRequest(), 500, securityKey, 0), undefined);
  assert.equal(
    authenticationRecord(securityRequest({ path: '/api/auth/login/unknown' }), 401, securityKey, 0),
    undefined,
  );
});

test('only server-marked service or session failures enter security logs and successful business calls do not', () => {
  for (const authType of ['ai_business', 'ai_persona', 'ai_insights', 'admin_session']) {
    const request = securityRequest({ path: '/api/private', securityAuthType: authType });
    assert.equal(
      authenticationRecord(request, 401, securityKey, 0).reason,
      authType === 'admin_session' ? 'invalid_session' : 'invalid_service_token',
    );
    assert.equal(authenticationRecord(request, 200, securityKey, 0), undefined);
    assert.equal(authenticationRecord(request, 401, securityKey, 0).accountKey, undefined);
    if (authType.startsWith('ai_'))
      assert.equal(
        authenticationRecord(request, 503, securityKey, 0).reason,
        'service_unconfigured',
      );
  }
  assert.equal(
    authenticationRecord(
      securityRequest({ path: '/api/private', body: { securityAuthType: 'ai_business' } }),
      401,
      securityKey,
      0,
    ),
    undefined,
  );
});

test('security log allowlist accepts only fixed types, reasons and hexadecimal pseudonyms', () => {
  const record = logRecord('info', {
    ...authenticationRecord(securityRequest(), 401, securityKey, 0),
    loginId: 'PRIVATE-user',
    ip: '192.0.2.1',
    token: securityKey,
  });
  assert.equal(record.authType, 'admin_login');
  assert.match(record.accountKey, /^[a-f0-9]{64}$/);
  assert.equal(record.loginId, undefined);
  assert.equal(record.ip, undefined);
  assert.equal(record.token, undefined);
  const invalid = logRecord('warn', {
    event: 'authentication_failure',
    authType: 'PRIVATE',
    reason: 'PRIVATE',
    accountKey: 'PRIVATE',
    sourceKey: 'a'.repeat(65),
  });
  for (const field of ['authType', 'reason', 'accountKey', 'sourceKey'])
    assert.equal(invalid[field], undefined);
  const ordinary = logRecord('info', {
    event: 'http_request',
    authType: 'admin_login',
    accountKey: 'a'.repeat(64),
  });
  assert.equal(ordinary.authType, undefined);
  assert.equal(ordinary.accountKey, undefined);
});

test('response completion emits one security result and preserves the HTTP record without exposing credentials', () => {
  const logs = [];
  const response = new EventEmitter();
  response.statusCode = 401;
  response.setHeader = () => {};
  const request = securityRequest({ route: { path: '/api/auth/login' } });
  requestContext({ log: (record) => logs.push(record) }, { key: securityKey, proxyHops: 0 })(
    request,
    response,
    () => {},
  );
  response.emit('finish');
  response.emit('finish');
  assert.equal(logs.filter((x) => x.event === 'http_request').length, 1);
  assert.equal(logs.filter((x) => x.event === 'authentication_failure').length, 1);
  assert.equal(logs[0].requestId, logs[1].requestId);
  assert.ok(!JSON.stringify(logs).includes('PRIVATE-password'));
  assert.ok(!httpMetrics().includes(logs[1].accountKey));
  assert.ok(!httpMetrics().includes(logs[1].sourceKey));
});
const transactionStatistics = {
  count: 7,
  failures: 2,
  seconds: 1.25,
  maxSeconds: 0.75,
  connectionWaitSeconds: 0.1,
};
const poolStatistics = { totalCount: 5, idleCount: 2, waitingCount: 3 };

test('FAQ retry logs preserve only a validated event ID and discard content and credentials', () => {
  const eventId = randomUUID();
  const record = logRecord('warn', {
    event: 'faq_notification_retry',
    eventId,
    question: 'private FAQ content',
    token: 'private token',
  });
  assert.equal(record.event, 'faq_notification_retry');
  assert.equal(record.eventId, eventId);
  assert.equal(record.question, undefined);
  assert.equal(record.token, undefined);
  assert.equal(
    logRecord('warn', { event: 'faq_notification_deferred', eventId: 'private' }).eventId,
    undefined,
  );
});

test('structured output never serializes nested PII, raw errors, signed URLs or credentials', () => {
  const lines = [];
  const logger = new JsonLogger((line) => lines.push(line));
  const marker = 'PRIVATE-01012345678-서울주소-token';
  const circular = {
    event: 'request_failed',
    requestId: randomUUID(),
    statusCode: 500,
    body: { text: marker },
    headers: { Authorization: marker },
    message: marker,
    error: new Error(marker),
    url: `https://example.invalid?token=${marker}`,
  };
  circular.self = circular;
  logger.error(circular);
  logger.error(new Error(marker));
  logger.log(marker);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.endsWith('\n') && line.split('\n').length === 2));
  assert.ok(!lines.join('').includes(marker));
  const record = JSON.parse(lines[0]);
  assert.equal(record.requestId, circular.requestId);
  assert.equal(record.statusCode, 500);
  assert.match(record.timestamp, /Z$/);
  assert.equal(record.service, 'backend');
});

test('invalid identifier and diagnostic fields cannot become structured log values', () => {
  const value = logRecord('info', {
    event: 'secret-event',
    requestId: '01012345678',
    orderSeq: '01012345678',
    callSessionSeq: -1,
    statusCode: 999,
    route: '/customers/01012345678?key=secret',
    method: 'secret',
    durationMs: Infinity,
    outcome: 'secret',
    reason: 'secret',
  });
  assert.deepEqual(
    Object.keys(value).sort(),
    ['timestamp', 'service', 'environment', 'level', 'event'].sort(),
  );
  assert.equal(value.event, 'application_message');
});

test('asynchronous logs keep concurrent request IDs separate', async () => {
  const records = [];
  const logger = new JsonLogger((line) => records.push(JSON.parse(line)));
  const ids = Array.from({ length: 12 }, () => randomUUID());
  await Promise.all(
    ids.map((requestId, index) =>
      logContext.run({ requestId }, async () => {
        await delay(index % 3);
        logger.log({
          event: 'dver_submission',
          orderSeq: index + 1,
          outcome: 'SUBMISSION_FAILED',
          reason: 'timeout',
        });
      }),
    ),
  );
  for (const record of records) assert.equal(record.requestId, ids[record.orderSeq - 1]);
  logger.log({ event: 'backend_started' });
  assert.equal(records.at(-1).requestId, undefined);
});

test('an unavailable log sink does not escape into a request or response finish handler', () => {
  const logger = new JsonLogger(() => {
    throw new Error('disk unavailable');
  });
  assert.doesNotThrow(() => logger.error({ event: 'request_failed' }));
  const response = new EventEmitter();
  response.statusCode = 201;
  response.setHeader = () => {};
  const request = {
    path: '/api/orders',
    route: { path: '/api/orders' },
    method: 'POST',
    get: () => undefined,
  };
  requestContext({
    log: () => {
      throw new Error('collector down');
    },
  })(request, response, () => {});
  assert.doesNotThrow(() => response.emit('finish'));
});

test('HTTP duration histogram exposes cumulative buckets, count and sum for percentile queries', () => {
  recordHttp('/api/histogram-contract', 'GET', 200, 25);
  recordHttp('/api/histogram-contract', 'GET', 200, 600);
  const metrics = httpMetrics();
  const labels = 'route="/api/histogram-contract",method="GET",status="200"';
  for (const [bound, count] of [
    ['0.01', 0],
    ['0.05', 1],
    ['0.1', 1],
    ['0.5', 1],
    ['1', 2],
    ['2', 2],
    ['5', 2],
    ['+Inf', 2],
  ])
    assert.ok(
      metrics.includes(
        `dva_http_request_duration_seconds_bucket{${labels},le="${bound}"} ${count}\n`,
      ),
    );
  assert.ok(metrics.includes(`dva_http_request_duration_seconds_count{${labels}} 2\n`));
  assert.ok(metrics.includes(`dva_http_request_duration_seconds_sum{${labels}} 0.625\n`));
});

test('HTTP error metrics count only submission server failures and have bounded cardinality', () => {
  for (const status of [201, 400, 401, 403, 409, 422])
    recordHttp('/api/admin/orders', 'POST', status, 1);
  recordHttp('/api/orders/:id/cancel', 'POST', 500, 1);
  recordHttp('/api/admin/orders', 'POST', 503, 1);
  recordHttp('/api/orders/:id/submit', 'POST', 500, 1);
  assert.match(httpMetrics(), /dva_submission_http_errors_total 2\n/);
  for (let i = 0; i < 2000; i++) recordHttp(`/bounded/${i}`, 'GET', 200, 1);
  assert.ok(
    httpMetrics()
      .split('\n')
      .filter((line) => line.startsWith('dva_http_requests_total{')).length <= 262,
  );
  assert.ok(!httpMetrics().includes('requestId='));
});

test('DB failure and order-query failure are distinct and never report an empty successful snapshot', async () => {
  const disconnected = new ObservabilityService({
    transactionStatistics,
    pool: {
      ...poolStatistics,
      query: async () => {
        throw new Error('private SQL');
      },
    },
  });
  const down = await disconnected.snapshot();
  assert.match(down, /dva_database_up 0/);
  assert.match(down, /dva_order_metrics_success 0/);
  assert.ok(!down.includes('dva_orders_attention'));
  const badQuery = new ObservabilityService({
    transactionStatistics,
    readSnapshot: DatabaseService.prototype.readSnapshot,
    pool: { ...poolStatistics, query: async () => ({}) },
    transaction: async () => {
      throw new Error('private parameters');
    },
  });
  const failed = await badQuery.snapshot();
  assert.match(failed, /dva_database_up 1/);
  assert.match(failed, /dva_order_metrics_success 0/);
  assert.ok(!failed.includes('private'));
});

test('concurrent metrics requests share one bounded database read', async () => {
  let reads = 0;
  const queries = [];
  const service = new ObservabilityService({
    transactionStatistics,
    readSnapshot: DatabaseService.prototype.readSnapshot,
    pool: {
      ...poolStatistics,
      query: async () => {
        reads++;
        await delay(5);
      },
    },
    transaction: async (work) =>
      work({
        query: async (sql) => {
          queries.push(sql);
          return {
            rows: sql.includes('GROUP BY')
              ? [{ status: 'SUBMISSION_FAILED', count: '2' }]
              : [{ count: '1' }],
          };
        },
      }),
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => service.snapshot()));
  assert.equal(reads, 1);
  assert.ok(results.every((body) => body === results[0]));
  assert.match(results[0], /dva_orders_attention\{status="SUBMISSION_FAILED"\} 2/);
  assert.match(results[0], /dva_orders_stale_submitting 1/);
  assert.match(results[0], /dva_database_pool_connections\{state="total"\} 5/);
  assert.match(results[0], /dva_database_pool_connections\{state="idle"\} 2/);
  assert.match(results[0], /dva_database_pool_waiting_requests 3/);
  assert.match(results[0], /dva_database_transactions_total 7/);
  assert.match(results[0], /dva_database_transaction_failures_total 2/);
  assert.match(results[0], /dva_database_transaction_duration_seconds_total 1.25/);
  assert.match(results[0], /dva_database_transaction_duration_seconds_max 0.75/);
  assert.match(results[0], /dva_database_transaction_connection_wait_seconds_total 0.1/);
  assert.match(queries[0], /READ ONLY/);
  assert.ok(queries.every((sql) => !/UPDATE|INSERT|DELETE/.test(sql)));
});

test('background event names survive redaction while complaint summaries never contain source data', () => {
  const events = [
    'call_complaint_claim_deferred',
    'call_complaint_failed',
    'call_complaint_recording_unavailable',
    'call_complaint_input_too_long',
    'call_complaint_model_unavailable',
    'call_complaint_judged',
    'active_call_count_unavailable',
    'card_payment_deferred',
    'order_intake_finalization_deferred',
    'order_intake_submission_deferred',
    'order_intake_recovery_failed',
    'card_revocation_deferred',
    'call_end_matching_deferred',
  ];
  for (const event of events) {
    const record = logRecord('warn', {
      event,
      callSessionSeq: 459,
      orderSeq: 231,
      hasComplaint: true,
      complaintCount: 3,
      phoneNumber: '01012345678',
      cardNumber: '4111111111111111',
      billingKey: 'private-billing-key',
      paymentKey: 'private-payment-key',
      types: ['PRIVATE evidence'],
      votes: 'PRIVATE votes',
      utteranceText: 'PRIVATE transcript',
      address: 'PRIVATE address',
      error: new Error('PRIVATE error'),
    });
    assert.equal(record.event, event);
    assert.ok(!JSON.stringify(record).match(/PRIVATE|private-|01012345678|4111111111111111/));
    assert.equal(record.callSessionSeq, 459);
    if (event === 'call_complaint_judged') {
      assert.equal(record.hasComplaint, true);
      assert.equal(record.complaintCount, 3);
    }
  }
  assert.equal(logRecord('info', { event: 'unknown-private-event' }).event, 'application_message');
  assert.equal(
    logRecord('info', { event: 'call_complaint_judged', complaintCount: 'PRIVATE' }).complaintCount,
    undefined,
  );
});

test('one failed attempt is audited once across domain and HTTP boundaries without suppressing a later request', async () => {
  const { AuditService } = require('../dist/audit/audit.service');
  const rows = [];
  const audit = new AuditService({ insert: async (...args) => rows.push(args) });
  const error = new Error('PRIVATE payment key');
  const event = {
    actorId: null,
    targetId: 1,
    targetType: 'ORDER',
    action: 'ORDER_CARD_PAYMENT',
    requestId: randomUUID(),
  };
  await audit.recordFailure(event, error);
  await audit.recordFailure({ ...event, action: 'ORDER_PAYMENT_RECONCILED' }, error);
  assert.equal(rows.length, 1);
  await audit.recordFailure({ ...event, requestId: randomUUID() }, error);
  assert.equal(rows.length, 2);
  assert.ok(!JSON.stringify(rows).includes('PRIVATE'));
});
