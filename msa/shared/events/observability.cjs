const { randomUUID } = require('node:crypto');

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const durationBuckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

async function outboxMetrics(pool) {
  let client;
  let discard = false;
  const lines = [
    '# TYPE dva_outbox_metrics_success gauge',
    '# TYPE dva_outbox_pending gauge',
    '# TYPE dva_outbox_retrying gauge',
    '# TYPE dva_outbox_oldest_pending_seconds gauge',
  ];
  try {
    client = await pool.connect();
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout = '1s'");
    const { rows: [row] } = await client.query(`
      SELECT count(*)::text AS pending,
             (count(*) FILTER (WHERE attempt_count > 0))::text AS retrying,
             GREATEST(0, EXTRACT(EPOCH FROM statement_timestamp() - min(occurred_at)))::float8 AS oldest
      FROM outbox_events WHERE delivered_at IS NULL
    `);
    await client.query('COMMIT');
    lines.push('dva_outbox_metrics_success 1',
      `dva_outbox_pending ${row.pending}`,
      `dva_outbox_retrying ${row.retrying}`,
      `dva_outbox_oldest_pending_seconds ${row.oldest}`);
  } catch {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    lines.push('dva_outbox_metrics_success 0');
  } finally {
    client?.release(discard);
  }
  return lines.join('\n') + '\n';
}

function metricsHandler(pool, httpMetrics) {
  let pending;
  async function collect() {
    let up = 0;
    try { await pool.query('SELECT 1'); up = 1; } catch { /* Report the failed probe. */ }
    return [
      httpMetrics().trimEnd(),
      '# TYPE dva_database_up gauge',
      `dva_database_up ${up}`,
      '# TYPE dva_database_pool_connections gauge',
      `dva_database_pool_connections{state="total"} ${pool.totalCount}`,
      `dva_database_pool_connections{state="idle"} ${pool.idleCount}`,
      '# TYPE dva_database_pool_waiting_requests gauge',
      `dva_database_pool_waiting_requests ${pool.waitingCount}`,
      up ? (await outboxMetrics(pool)).trimEnd() : 'dva_outbox_metrics_success 0',
      '',
    ].join('\n');
  }
  return async (_request, response) => {
    pending ??= collect().finally(() => { pending = undefined; });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    response.end(await pending);
  };
}

// Delivery uses this observer until it has the common Nest request context.
function createHttpTelemetry() {
  const counters = new Map();
  function observe(request, response, next) {
    const path = request.path;
    if (path === '/internal/metrics' || path.startsWith('/delivery/health')) {
      next();
      return;
    }
    const incoming = request.headers['x-request-id'];
    const requestId = typeof incoming === 'string' && UUID.test(incoming) ? incoming : randomUUID();
    const start = performance.now();
    response.once('finish', () => {
      const statusCode = response.statusCode;
      const durationMs = Math.round(performance.now() - start);
      if (!counters.has(statusCode)) {
        counters.set(statusCode, { count: 0, seconds: 0, buckets: durationBuckets.map(() => 0) });
      }
      const entry = counters.get(statusCode);
      entry.count++;
      entry.seconds += durationMs / 1000;
      durationBuckets.forEach((limit, i) => {
        if (durationMs <= limit * 1000) entry.buckets[i]++;
      });
      console.log(JSON.stringify({ event: 'http_request', requestId, method: request.method, statusCode, durationMs }));
    });
    next();
  }
  function metrics() {
    const lines = ['# TYPE dva_http_requests_total counter', '# TYPE dva_http_request_duration_seconds histogram'];
    for (const [status, entry] of counters) {
      const label = `status="${status}"`;
      lines.push(`dva_http_requests_total{${label}} ${entry.count}`,
        `dva_http_request_duration_seconds_count{${label}} ${entry.count}`,
        `dva_http_request_duration_seconds_sum{${label}} ${entry.seconds}`);
      durationBuckets.forEach((limit, i) => lines.push(
        `dva_http_request_duration_seconds_bucket{${label},le="${limit}"} ${entry.buckets[i]}`,
      ));
      lines.push(`dva_http_request_duration_seconds_bucket{${label},le="+Inf"} ${entry.count}`);
    }
    return lines.join('\n') + '\n';
  }
  return { observe, metrics };
}

module.exports = { createHttpTelemetry, metricsHandler, outboxMetrics };
