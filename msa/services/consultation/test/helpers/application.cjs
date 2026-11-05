require('reflect-metadata');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { NestFactory } = require('@nestjs/core');

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

module.exports = { createTestPool, startTestApp };
