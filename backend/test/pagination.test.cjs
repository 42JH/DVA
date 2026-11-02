require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { ListResponse } = require('../dist/common/pagination');

test('list responses preserve the query total across short, empty and overscanned pages', () => {
  assert.deepEqual(
    { ...new ListResponse({ rows: [{ id: 2 }, { id: 1 }], total_count: 25 }, 1) },
    { data: [{ id: 2 }], hasNext: true, total_count: 25 },
  );
  assert.deepEqual(
    { ...new ListResponse({ rows: [], total_count: 25 }, 20) },
    { data: [], hasNext: false, total_count: 25 },
  );
  assert.deepEqual(
    { ...new ListResponse({ rows: [], total_count: 0 }, 20) },
    { data: [], hasNext: false, total_count: 0 },
  );
});

test('list responses require a nonnegative safe integer count and a valid page limit', () => {
  for (const total_count of [undefined, null, '1', -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => new ListResponse({ rows: [], total_count }, 20), RangeError);
  for (const limit of [undefined, 0, -1, 1.5, 101])
    assert.throws(() => new ListResponse({ rows: [], total_count: 0 }, limit), RangeError);
});

test('every paginated API documents total_count as required, including both FAQ audiences', async () => {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DB_HOST: 'db',
    DB_USER: 'test_user',
    DB_PASSWORD: 'test-only-password',
    DB_NAME: 'dva_webhook_test',
    AI_AGENT_URL: 'http://ai.invalid:8000',
    SWAGGER_ENABLED: 'false',
  });
  const { AppModule } = require('../dist/app.module');
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  try {
    // 문서 생성에는 앱 시작이나 DB 접속이 필요하지 않다.
    const spec = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    const resolve = (schema) =>
      schema.$ref ? spec.components.schemas[schema.$ref.split('/').at(-1)] : schema;
    const expected = [
      '/admins',
      '/customers',
      '/companies',
      '/companies/search',
      '/companies/{id}/departments',
      '/companies/{id}/members',
      '/personas',
      '/personas/{id}/versions',
      '/customers/{id}/pins',
      '/orders',
      '/admin/orders',
      '/customers/{id}/addresses',
      '/audit-logs',
      '/faqs',
      '/ai/faqs',
      '/calls',
      '/calls/{id}/transcript',
      '/calls/{id}/actions',
      '/calls/{id}/processing-results',
      '/unanswered-questions',
    ];
    const actual = [];
    for (const [route, methods] of Object.entries(spec.paths)) {
      const schema = methods.get?.responses?.['200']?.content?.['application/json']?.schema;
      if (!schema) continue;
      const response = resolve(schema);
      if (!response.properties?.hasNext) continue;
      actual.push(route);
      assert.ok(response.required.includes('total_count'), route);
      assert.equal(response.properties.total_count.type, 'integer', route);
      assert.equal(response.properties.total_count.minimum, 0, route);
      assert.equal(response.properties.data.type, 'array', route);
    }
    assert.deepEqual(actual.sort(), expected.sort());
  } finally {
    await app.close();
  }
});
