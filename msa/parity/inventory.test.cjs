const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inventory } = require('./inventory.cjs');
const baseline = require('./baseline.json');

test('the complete monolith route, migration and worker inventory matches the pinned baseline', () => {
  assert.deepEqual(inventory(), baseline.inventory);
  assert.equal(baseline.inventory.routes.length, 96);
  const keys = baseline.inventory.routes.map(r => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const required of ['GET /api/calls/active-count/stream', 'POST /webhooks/pbx/call-ended',
    'GET /api/companies/members/search', 'GET /api/payments/p/:id', 'POST /api/ai/calls/:id/events', 'GET /health/ready'])
    assert.ok(keys.includes(required), required);
  assert.ok(baseline.inventory.migrations.at(-1).file.endsWith('053-drop-company-pins.sql'));
});
