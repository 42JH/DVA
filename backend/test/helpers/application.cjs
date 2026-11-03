require('reflect-metadata');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { migrate } = require('./migrations.cjs');

function createTestPool() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
}

async function startTestApp(apps, logger = { log: () => {} }) {
  const { AppModule } = require('../../dist/app.module');
  const { configureApplication } = require('../../dist/configure-application');
  const app = await NestFactory.create(AppModule, { logger: false });
  apps.push(app);
  configureApplication(app, logger);
  await app.listen(0, '127.0.0.1');
  return app;
}

function applicationFixture(name = '통합 테스트 관리자') {
  const pool = createTestPool();
  process.env.SWAGGER_ENABLED = 'true';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  const { hashPassword } = require('../../dist/auth/password');
  const f = {
    pool,
    origin: 'http://localhost:5173',
    apps: [],
    cookies: [],
    ids: [],
    loginIds: [],
    logs: [],
  };
  f.start = () => startTestApp(f.apps, { log: (entry) => f.logs.push(entry) });
  f.get = (path, actor = 0, headers = {}) =>
    fetch(f.base + path, {
      headers: Object.fromEntries(
        Object.entries({ Cookie: f.cookies[actor], ...headers }).filter(([, v]) => v !== undefined),
      ),
    });
  f.write = (method, path, body, actor = 0, headers = {}) =>
    fetch(f.base + path, {
      method,
      headers: Object.fromEntries(
        Object.entries({
          Origin: f.origin,
          Cookie: f.cookies[actor],
          'Content-Type': 'application/json',
          ...headers,
        }).filter(([, v]) => v !== undefined),
      ),
      body: JSON.stringify(body),
    });
  f.error = async (response, status, code) => {
    assert.equal(response.status, status, await response.clone().text());
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.ok(body.meta.requestId);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return body;
  };
  before(async () => {
    await migrate(pool);
    f.app = await f.start();
    f.base = await f.app.getUrl();
    const password = 'integration-test-only-password';
    const hash = await hashPassword(password);
    for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
      const loginId = 'test' + randomUUID().replaceAll('-', '').slice(0, 16);
      f.loginIds.push(loginId);
      f.ids.push(
        (
          await pool.query(
            "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,$2,$3,$4,'ACTIVE') RETURNING admin_user_seq",
            [loginId, name, hash, role],
          )
        ).rows[0].admin_user_seq,
      );
      const response = await fetch(f.base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: f.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginId, password }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      f.cookies.push(response.headers.get('set-cookie').split(';')[0]);
    }
  });
  after(async () => {
    for (const app of f.apps) await app.close();
    await pool.end();
  });
  return f;
}

module.exports = { applicationFixture, createTestPool, startTestApp };
