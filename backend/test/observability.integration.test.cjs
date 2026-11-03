require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.DB_NAME, 'dva_webhook_test');
process.env.SWAGGER_ENABLED = 'true';
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { DatabaseModule } = require('../dist/database/database.module');
const { DatabaseService } = require('../dist/database/database.service');
const { ApplicationConfigModule } = require('../dist/config/application-config.module');
const { AuthModule } = require('../dist/auth/auth.module');
const { ObservabilityModule } = require('../dist/observability/observability.module');
const { configureApplication } = require('../dist/configure-application');
const { ObservabilityService } = require('../dist/observability/observability.service');
class FixtureModule {}
Module({ imports: [ApplicationConfigModule, DatabaseModule, AuthModule, ObservabilityModule] })(
  FixtureModule,
);
let app, base, database;
const ids = [];
before(async () => {
  app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  configureApplication(app, { log() {} });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  database = app.get(DatabaseService);
});
after(async () => {
  try {
    if (ids.length)
      await database.pool.query('DELETE FROM orders WHERE order_seq = ANY($1::integer[])', [ids]);
  } finally {
    if (app) await app.close();
  }
});
test('internal metrics are text, independent of AI and absent from public Swagger', async () => {
  const response = await fetch(base + '/internal/metrics');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/plain/);
  const body = await response.text();
  assert.match(body, /dva_database_up 1/);
  assert.match(body, /dva_order_metrics_success 1/);
  assert.ok(!body.includes('ai_agent'));
  const spec = await (await fetch(base + '/api/docs-json')).json();
  assert.ok(!Object.keys(spec.paths).some((path) => path.includes('internal')));
  assert.equal((await fetch(base + '/api/internal/metrics')).status, 404);
});
test('stale detection reads committed order state without changing status, version or audit records', async () => {
  const initial = (
    await database.pool.query(
      "SELECT count(*)::int AS n FROM orders WHERE status='SUBMITTING' AND deleted_at IS NULL AND COALESCE(submission_last_attempt_at,updated_at)<=statement_timestamp()-interval '10 seconds'",
    )
  ).rows[0].n;
  for (const [status, old] of [
    ['PAID', false],
    ['SUBMISSION_FAILED', false],
    ['SUBMITTING_FAILED', false],
    ['SUBMITTING', true],
    ['SUBMITTING', false],
  ]) {
    const row = (
      await database.pool.query(
        "INSERT INTO orders(status,payment_method_type,pickup_requested_at,updated_at) VALUES($1,'billing',now()+interval '1 day',now()-$2::interval) RETURNING order_seq",
        [status, old ? '2 minutes' : '0 seconds'],
      )
    ).rows[0];
    ids.push(row.order_seq);
  }
  const beforeRows = (
    await database.pool.query(
      'SELECT * FROM orders WHERE order_seq=ANY($1::int[]) ORDER BY order_seq',
      [ids],
    )
  ).rows;
  const metrics = await app.get(ObservabilityService).snapshot();
  assert.match(metrics, new RegExp(`dva_orders_stale_submitting ${initial + 1}\\n`));
  assert.deepEqual(
    (
      await database.pool.query(
        'SELECT * FROM orders WHERE order_seq=ANY($1::int[]) ORDER BY order_seq',
        [ids],
      )
    ).rows,
    beforeRows,
  );
});
