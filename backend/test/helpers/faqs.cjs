require('reflect-metadata');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');

module.exports = function faqFixture() {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
  process.env.SWAGGER_ENABLED = 'true';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  const { AppModule } = require('../../dist/app.module');
  const { configureApplication } = require('../../dist/configure-application');
  const { hashPassword } = require('../../dist/auth/password');
  const pool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  const f = {
    pool,
    origin: 'http://localhost:5173',
    apps: [],
    cookies: [],
    ids: [],
    loginIds: [],
    logs: [],
  };
  f.marker = () => 'faq' + randomUUID().replaceAll('-', '');
  f.start = async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    f.apps.push(app);
    configureApplication(app, { log: (entry) => f.logs.push(entry) });
    await app.listen(0, '127.0.0.1');
    return app;
  };
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
  f.create = (body, actor = 0, headers = {}) => f.write('POST', '/api/faqs', body, actor, headers);
  f.patch = (id, body, actor = 0, headers = {}) =>
    f.write('PATCH', `/api/faqs/${id}`, body, actor, headers);
  f.ai = (suffix = '', headers = {}) =>
    f.get('/api/ai/faqs' + suffix, 0, { Cookie: undefined, ...headers });
  f.error = async (response, status, code) => {
    assert.equal(response.status, status, await response.clone().text());
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.ok(body.meta.requestId);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return body;
  };
  f.createdId = async (input, actor = 0) => {
    const response = await f.create(input, actor);
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const id = Number(response.headers.get('location').split('/').at(-1));
    assert.ok(id > 0);
    return id;
  };
  f.counts = async () =>
    (
      await pool.query(
        "SELECT (SELECT count(*)::int FROM faq_entries) AS faqs,(SELECT count(*)::int FROM audit_logs WHERE target_type='FAQ_ENTRY' AND result='SUCCESS') AS audits",
      )
    ).rows[0];
  before(async () => {
    assert.ok(
      (await pool.query("SELECT to_regclass('public.faq_entries') AS name")).rows[0].name,
      'Run with the integration suite schema setup',
    );
    f.app = await f.start();
    f.base = await f.app.getUrl();
    const password = 'faq-test-only-password';
    const hash = await hashPassword(password);
    for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
      const loginId = 'faq' + randomUUID().replaceAll('-', '').slice(0, 17);
      f.loginIds.push(loginId);
      f.ids.push(
        (
          await pool.query(
            "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'FAQ 관리자',$2,$3,'ACTIVE') RETURNING admin_user_seq",
            [loginId, hash, role],
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
};
