const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverage, envelope, schema, generatedTimes, countSnapshot } = require('./final-parity.cjs');

test('a missing declaration cannot pass merely because both invalid-ID probes return 404', () => {
  const reference = [{ method: 'GET', path: '/api/orders/:id' }, { method: 'POST', path: '/api/orders' }];
  assert.deepEqual(coverage(reference, reference.slice(0, 1)).map(route => route.declared), [true, false]);
  assert.deepEqual(coverage(reference, [{ method: 'GET', path: '/api/orders' }]).map(route => route.declared), [false, false]);
  assert.equal(coverage([{ ...reference[0], service: 'order' }],
    [{ ...reference[0], service: 'customer' }])[0].declared, false);
});

test('response timestamp normalization retains business IDs, amounts, states and times', () => {
  const value = { data: { id: 5, amount: 42, status: 'PAID', deletedAt: '2020-01-01T00:00:00Z' },
    meta: { requestId: 'final-check', timestamp: new Date().toISOString() } };
  assert.deepEqual(envelope(value, 'final-check').data, value.data);
  assert.notEqual(envelope(value, 'final-check').meta.timestamp, value.meta.timestamp);
  assert.throws(() => envelope(value, 'other'));
  assert.throws(() => envelope({ meta: { requestId: 'final-check', timestamp: 'bad' } }, 'final-check'));
});

test('OpenAPI comparison expands referenced DTOs without dropping validation or auth requirements', () => {
  const document = { components: { schemas: { Input: { type: 'object', required: ['phone'],
    properties: { phone: { type: 'string', pattern: '^0[0-9]{10}$', description: 'copy' } } } } } };
  const expanded = schema({ $ref: '#/components/schemas/Input' }, document);
  assert.deepEqual(expanded.required, ['phone']);
  assert.equal(expanded.properties.phone.pattern, '^0[0-9]{10}$');
  assert.deepEqual(schema({ security: [{ bearer: [] }], description: 'copy' }, document), { security: [{ bearer: [] }] });
  assert.throws(() => schema({ $ref: '#/components/schemas/Missing' }, document));
});

test('only newly generated create/update times are bounded; business and historical times remain exact', () => {
  const start = Date.parse('2026-11-08T10:00:00Z'), end = start + 1000;
  const value = { amount: 42, version: 7, createdAt: '2026-11-08T10:00:00.001Z',
    updatedAt: '2026-11-08T10:00:00.002Z', incomingAt: '2026-11-08T10:00:00.001Z',
    deletedAt: '2026-11-08T10:00:00.002Z', retention_started_at: '2026-11-08T10:00:00.001Z',
    old: { createdAt: '2020-01-01T00:00:00Z' } };
  const result = generatedTimes(value, start, end);
  assert.equal(result.createdAt, result.updatedAt);
  for (const key of ['amount', 'version', 'incomingAt', 'deletedAt', 'retention_started_at', 'old'])
    assert.deepEqual(result[key], value[key]);
  assert.notDeepEqual(generatedTimes({ createdAt: new Date(end + 1) }, start, end),
    generatedTimes({ createdAt: new Date(start + 1) }, start, end));
  assert.throws(() => generatedTimes({ createdAt: '2026-11-08T10:00:00.002Z', updatedAt: '2026-11-08T10:00:00.001Z' }, start, end));
  assert.throws(() => generatedTimes({ created_at: new Date(start + 2), updated_at: new Date(start + 1) }, start, end));
});

test('active-count clock normalization requires a valid recent snapshot and retains its count', () => {
  const start = Date.parse('2026-11-08T10:00:00Z');
  const value = { activeCallCount: 3, observedAt: new Date(start).toISOString() };
  assert.equal(countSnapshot(value, start, start + 1000).activeCallCount, 3);
  assert.throws(() => countSnapshot({ ...value, activeCallCount: -1 }, start, start));
  assert.throws(() => countSnapshot({ ...value, observedAt: 'invalid' }, start, start));
  assert.throws(() => countSnapshot(value, start + 20000, start + 21000));
});
