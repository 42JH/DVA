require('reflect-metadata');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');
const { before, after } = require('node:test');
const { randomUUID, randomBytes, createHash } = require('node:crypto');

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
  const identity = new Pool({ ...pool.options, host: 'operations-db', user: 'operations_app', password: process.env.DB_PASSWORD });
  process.env.SWAGGER_ENABLED = 'false';
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  const f = { pool, apps: [], cookies: [], ids: [], logs: [], origin: 'http://localhost:5173' };
  f.start = () => startTestApp(f.apps, { log: entry => f.logs.push(entry) });
  f.get = (path, actor = 0, headers = {}) => fetch(f.base + path, {
    headers: Object.fromEntries(Object.entries({ Cookie: f.cookies[actor], ...headers }).filter(([, value]) => value !== undefined)),
  });
  before(async () => {
    f.app = await f.start(); f.base = await f.app.getUrl();
    for (const role of ['OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN']) {
      const login = 'test' + randomUUID().replaceAll('-', '').slice(0, 16), token = randomBytes(32).toString('hex');
      const id = (await identity.query("INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,$2,'not-for-login',$3,'ACTIVE') RETURNING admin_user_seq", [login, name, role])).rows[0].admin_user_seq;
      await identity.query('INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)', [createHash('sha256').update(token).digest('hex'), id]);
      f.ids.push(id); f.cookies.push('dva_session=' + token);
    }
  });
  after(async () => { for (const app of f.apps) await app.close(); await Promise.all([pool.end(), identity.end()]); });
  return f;
}

module.exports = { createTestPool, startTestApp, applicationFixture };
