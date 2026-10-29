require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { EventEmitter } = require('node:events');
const { JsonLogger, logRecord, logContext } = require('../dist/observability/json-logger');
const { ObservabilityService } = require('../dist/observability/observability.service');
const { recordHttp, httpMetrics } = require('../dist/observability/http-metrics');
const { requestContext } = require('../dist/common/http/request-context');

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
          outcome: 'REVIEW_REQUIRED',
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
    pool: {
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
    pool: { query: async () => ({}) },
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
    pool: {
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
              ? [{ status: 'REVIEW_REQUIRED', count: '2' }]
              : [{ count: '1' }],
          };
        },
      }),
  });
  const results = await Promise.all(Array.from({ length: 10 }, () => service.snapshot()));
  assert.equal(reads, 1);
  assert.ok(results.every((body) => body === results[0]));
  assert.match(results[0], /dva_orders_attention\{status="REVIEW_REQUIRED"\} 2/);
  assert.match(results[0], /dva_orders_stale_submitting 1/);
  assert.match(queries[0], /READ ONLY/);
  assert.ok(queries.every((sql) => !/UPDATE|INSERT|DELETE/.test(sql)));
});
