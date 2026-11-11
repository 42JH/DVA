const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inventory } = require('./inventory.cjs');
const baseline = require('./baseline.json');

test('the complete monolith route, migration and worker inventory matches the pinned baseline', () => {
  assert.deepEqual(inventory(), baseline.inventory);
  assert.equal(baseline.inventory.routes.length, 110);
  const keys = baseline.inventory.routes.map(r => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const required of ['GET /api/calls/active-count/stream', 'POST /webhooks/pbx/call-ended',
    'GET /api/companies/members/search', 'POST /api/calls/:id/order-intake/complete', 'GET /api/calls/:id/order-intake',
    'GET /api/parcel-drafts', 'POST /api/parcel-drafts', 'PATCH /api/parcel-drafts/:id',
    'GET /api/parcel-drafts/:id', 'DELETE /api/parcel-drafts/:id', 'POST /api/admin/parcel-drafts/:id/submit', 'GET /api/payments/p/:id', 'POST /api/ai/calls/:id/events', 'GET /health/ready'])
    assert.ok(keys.includes(required), required);
  assert.ok(baseline.inventory.migrations.at(-1).file.endsWith('062-customer-monthly-billing.sql'));
});
