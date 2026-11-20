require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { NestFactory } = require('@nestjs/core');
const { SwaggerModule, DocumentBuilder } = require('@nestjs/swagger');
const { ListResponse } = require('../dist/common/pagination');
const { CoalescedPages } = require('../dist/common/coalesced-pages');

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

test('concurrent pages share bounded reads and keep each page, total and metadata', async () => {
  const reads = new CoalescedPages();
  const calls = [];
  const items = Array.from({ length: 115 }, (_, index) => ({ index }));
  const load = async ({ offset, limit }) => {
    calls.push([offset, limit]);
    return Object.assign(
      new ListResponse({ rows: items.slice(offset, offset + limit + 1), total_count: 115 }, limit),
      { statusCounts: { all: 115 } },
    );
  };
  const first = reads.read([1], { offset: 0, limit: 20 }, load);
  assert.equal(reads.read([1], { offset: 0, limit: 20 }, load), first);
  const [a, b, last, empty] = await Promise.all([
    first,
    reads.read([1], { offset: 20, limit: 20 }, load),
    reads.read([1], { offset: 100, limit: 20 }, load),
    reads.read([1], { offset: 120, limit: 10 }, load),
  ]);
  assert.deepEqual(calls, [
    [0, 40],
    [100, 30],
  ]);
  assert.deepEqual(
    [a.data, b.data, last.data, empty.data],
    [items.slice(0, 20), items.slice(20, 40), items.slice(100), []],
  );
  assert.deepEqual([a.hasNext, b.hasNext, last.hasNext, empty.hasNext], [true, true, false, false]);
  for (const page of [a, b, last, empty]) {
    assert.equal(page.total_count, 115);
    assert.deepEqual(page.statusCounts, { all: 115 });
  }
});

test('late pages read a new snapshot and failures release the group for subsequent reads', async () => {
  const reads = new CoalescedPages();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let revision = 1;
  const load = async ({ offset, limit, q }) => {
    const observed = revision;
    if (q === 'fail') throw new Error('query failed');
    if (observed === 1) {
      started.resolve();
      await release.promise;
    }
    return new ListResponse({ rows: offset === 0 ? [{ observed }] : [], total_count: 1 }, limit);
  };
  const query = { offset: 0, limit: 10 };
  const first = reads.read([1], query, load);
  await started.promise;
  revision = 2;
  const late = reads.read([1], query, load);
  assert.notEqual(first, late);
  assert.deepEqual((await reads.read([2], query, load)).data, [{ observed: 2 }]);
  await assert.rejects(reads.read([1], { ...query, q: 'fail' }, load), /query failed/);
  release.resolve();
  assert.deepEqual((await first).data, [{ observed: 1 }]);
  assert.deepEqual((await late).data, [{ observed: 2 }]);
  revision = 3;
  assert.deepEqual((await reads.read([1], query, load)).data, [{ observed: 3 }]);
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
      '/companies/members/search',
      '/companies/{id}/billing/charges',
      '/companies/{id}/departments',
      '/companies/{id}/members',
      '/personas',
      '/personas/{id}/versions',
      '/customers/{id}/pins',
      '/orders',
      '/parcel-drafts',
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
