require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  Module,
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Query,
  Param,
  HttpCode,
  UnauthorizedException,
} = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { IsString, IsNotEmpty } = require('class-validator');
const { ApiProperty } = require('@nestjs/swagger');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DB_HOST: 'db',
  DB_USER: 'test_user',
  DB_PASSWORD: 'test-only',
  DB_NAME: 'dva_webhook_test',
  AI_AGENT_URL: 'http://ai:8000',
  CORS_ORIGINS: 'http://localhost:5173',
  SWAGGER_ENABLED: 'true',
  PBX_WEBHOOK_TOKEN: '',
});
const { ApplicationConfigModule } = require('../dist/config/application-config.module');
const { configureApplication } = require('../dist/configure-application');
const { PaginationQueryDto } = require('../dist/common/dto/pagination-query.dto');
const { ListResponse } = require('../dist/common/pagination');
const { ApiException } = require('../dist/common/errors/api.exception');
const { HealthController } = require('../dist/health/health.controller');
const { HealthService } = require('../dist/health/health.service');

class InputDto {}
IsString()(InputDto.prototype, 'name');
IsNotEmpty()(InputDto.prototype, 'name');
ApiProperty({ type: String })(InputDto.prototype, 'name');

// Fixtures exist only in the test module, never in the application or production image.
class FixtureController {
  list(query) {
    return new ListResponse(
      {
        rows: Array.from({ length: 21 }, (_, index) => ({ id: index + 1 })).slice(
          query.offset,
          query.offset + query.limit + 1,
        ),
        total_count: 21,
      },
      query.limit,
    );
  }
  create(body) {
    return body;
  }
  detail(id) {
    return { id };
  }
  remove() {
    return { ignored: true };
  }
  denied() {
    throw new UnauthorizedException('private diagnostic');
  }
  business() {
    throw new ApiException(422, 'BUSINESS_RULE_VIOLATION', '업무 조건을 확인해 주세요.', [
      { field: 'name', reason: 'RULE_FAILED' },
    ]);
  }
  databaseError() {
    throw Object.assign(new Error('SELECT secret FROM private_table; signed-url-secret'), {
      code: '23505',
      detail: 'phone=01000000001',
    });
  }
  failure() {
    throw new Error('private-password-and-query');
  }
}
Controller('checks')(FixtureController);
for (const [name, decorator] of [
  ['list', Get('items')],
  ['create', Post('items')],
  ['detail', Get('items/:id')],
  ['remove', Delete('items/:id')],
  ['denied', Get('denied')],
  ['business', Get('business')],
  ['databaseError', Get('database-error')],
  ['failure', Get('failure')],
])
  decorator(
    FixtureController.prototype,
    name,
    Object.getOwnPropertyDescriptor(FixtureController.prototype, name),
  );
HttpCode(204)(
  FixtureController.prototype,
  'remove',
  Object.getOwnPropertyDescriptor(FixtureController.prototype, 'remove'),
);
Query()(FixtureController.prototype, 'list', 0);
Body()(FixtureController.prototype, 'create', 0);
Param('id')(FixtureController.prototype, 'detail', 0);
Reflect.defineMetadata(
  'design:paramtypes',
  [PaginationQueryDto],
  FixtureController.prototype,
  'list',
);
Reflect.defineMetadata('design:paramtypes', [InputDto], FixtureController.prototype, 'create');
Reflect.defineMetadata('design:paramtypes', [String], FixtureController.prototype, 'detail');
class FixtureModule {}
Module({
  imports: [ApplicationConfigModule],
  controllers: [FixtureController, HealthController],
  providers: [
    { provide: HealthService, useValue: { checkDependencies: async () => ({ status: 'ok' }) } },
  ],
})(FixtureModule);

let app, base;
const logs = [];
before(async () => {
  app = await NestFactory.create(FixtureModule, { logger: false, abortOnError: false });
  configureApplication(app, { log: (value) => logs.push(value) });
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});
after(async () => {
  if (app) await app.close();
});
const request = (path, options) => fetch(base + path, options);

test('JSON bodies above the existing 100 KiB limit return a redacted 413 instead of a server error', async () => {
  const response = await request('/api/checks/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'private-oversize'.repeat(8000) }),
  });
  assert.equal(response.status, 413);
  const body = await response.json();
  assert.equal(body.error.code, 'PAYLOAD_TOO_LARGE');
  assert.doesNotMatch(JSON.stringify(body), /private-oversize/);
  assert.ok(body.meta.requestId);
});

test('API single response propagates a UUID and never changes the health contract', async () => {
  const requestId = randomUUID();
  const response = await request('/api/checks/items/1', {
    headers: { 'X-Request-Id': requestId },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-request-id'), requestId);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { data: { id: '1' }, meta: { requestId } });
  const health = await request('/health');
  assert.deepEqual(await health.json(), { status: 'ok', service: 'backend' });
});

test('pagination has data/hasNext/total_count, strict decimal integers and empty-page behavior', async () => {
  const first = await (await request('/api/checks/items')).json();
  assert.equal(first.data.length, 20);
  assert.equal(first.total_count, 21);
  assert.equal(first.hasNext, true);
  assert.deepEqual(Object.keys(first).sort(), ['data', 'hasNext', 'total_count']);
  assert.deepEqual(await (await request('/api/checks/items?offset=100')).json(), {
    data: [],
    hasNext: false,
    total_count: 21,
  });
  for (const query of [
    'limit=0',
    'limit=101',
    'limit=1.5',
    'limit=1e1',
    'limit=',
    'offset=-1',
    'offset=9007199254740992',
    'unexpected=1',
    'limit=1&limit=2',
  ]) {
    const response = await request('/api/checks/items?' + query);
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');
  }
});

test('DTO errors and malformed JSON use the common contract without returning input values', async () => {
  for (const body of [{ name: 42 }, { name: 'private-name', role: 'SYSTEM_ADMIN' }, {}]) {
    const response = await request('/api/checks/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error.code, 'INVALID_REQUEST');
    assert.ok(result.error.details.length > 0);
    assert.ok(!JSON.stringify(result).includes('private-name'));
    assert.equal(result.meta.requestId, response.headers.get('x-request-id'));
  }
  const malformed = await request('/api/checks/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{invalid',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'INVALID_REQUEST');
  const success = await request('/api/checks/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'example' }),
  });
  assert.equal(success.status, 201);
  assert.deepEqual((await success.json()).data, { name: 'example' });
});

test('204 responses have no body; framework, business and SQL errors are classified safely', async () => {
  const deleted = await request('/api/checks/items/1', { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  assert.equal(await deleted.text(), '');
  for (const [path, status, code] of [
    ['missing', 404, 'NOT_FOUND'],
    ['checks/denied', 401, 'UNAUTHORIZED'],
    ['checks/business', 422, 'BUSINESS_RULE_VIOLATION'],
    ['checks/database-error', 409, 'DUPLICATE_RESOURCE'],
    ['checks/failure', 500, 'INTERNAL_ERROR'],
  ]) {
    const response = await request('/api/' + path);
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.ok(
      !JSON.stringify(body).match(
        /private-password|SELECT secret|01000000001|signed-url-secret|private diagnostic/,
      ),
    );
    assert.ok(Array.isArray(body.error.details));
  }
});

test('CORS permits only the configured origin and required request headers', async () => {
  const response = await request('/api/checks/items', {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,idempotency-key,call_session_seq',
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  assert.ok(response.headers.get('access-control-allow-headers').includes('Idempotency-Key'));
  const allowedHeaders = response.headers
    .get('access-control-allow-headers')
    .toLowerCase()
    .split(',')
    .map((header) => header.trim());
  assert.ok(allowedHeaders.includes('call_session_seq'));
  assert.ok(!allowedHeaders.includes('x-call-session-id'));
  const forbidden = await request('/api/checks/items', {
    headers: { Origin: 'https://untrusted.invalid' },
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'FORBIDDEN');
});

test('OpenAPI JSON is served at the configured docs path and includes common error schemas', async () => {
  const response = await request('/api/docs-json');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.info.title, 'Dva Monolith API');
  assert.ok(body.paths['/api/checks/items']);
  assert.ok(body.components.schemas.ErrorResponseDto);
  assert.ok(!body.paths['/health']);
});

test('request logs contain route templates and IDs without queries, headers or body values', async () => {
  const requestId = randomUUID();
  await request('/api/checks/items/private-resource?phone=01000000001&token=query-secret', {
    headers: { Authorization: 'Bearer header-secret', 'X-Request-Id': requestId },
  });
  const entry = logs.find((value) => value.requestId === requestId);
  assert.ok(entry);
  assert.match(entry.route, /:id$/);
  assert.ok(!JSON.stringify(logs).match(/private-resource|01000000001|query-secret|header-secret/));
});
