const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inventory } = require('./inventory.cjs');
const baseline = require('./baseline.json');

test('the complete monolith route, migration and worker inventory matches the pinned baseline', () => {
  assert.deepEqual(inventory(), baseline.inventory);
  assert.equal(baseline.inventory.routes.length, 117);
  const keys = baseline.inventory.routes.map(r => `${r.method} ${r.path}`);
  assert.equal(new Set(keys).size, keys.length);
  for (const route of baseline.inventory.routes.filter(r=>r.path.startsWith('/api/calls/:id/order-intake'))) assert.equal(route.service,'consultation');
  for (const path of ['/api/customers/:id/card','/api/companies/:id/group-card']) {
    const routes=baseline.inventory.routes.filter(r=>r.path===path);
    assert.deepEqual(routes.map(r=>r.method).sort(),['GET','PUT']);
    assert.ok(routes.every(r=>r.service==='customer'));
  }
  assert.ok(keys.includes('PATCH /api/companies/:id/members'));
  for (const required of ['GET /api/calls/active-count/stream', 'POST /webhooks/pbx/call-ended',
    'GET /api/companies/members/search', 'POST /api/calls/:id/order-intake/complete', 'GET /api/calls/:id/order-intake',
    'GET /api/parcel-drafts', 'POST /api/parcel-drafts', 'PATCH /api/parcel-drafts/:id',
    'GET /api/parcel-drafts/:id', 'DELETE /api/parcel-drafts', 'POST /api/admin/parcel-drafts/:id/submit', 'GET /api/payments/p/:id', 'POST /api/ai/calls/:id/events', 'GET /health/ready'])
    assert.ok(keys.includes(required), required);
  assert.ok(keys.includes('DELETE /api/personas'));
  for(const [path,service] of [
    ['/api/admins','operations'],['/api/calls','consultation'],['/api/unanswered-questions','consultation'],
    ['/api/orders','order'],['/api/parcel-drafts','order'],['/api/members','customer'],
    ['/api/departments','customer'],['/api/customers/cards','customer'],['/api/companies/group-cards','customer'],
  ])assert.equal(baseline.inventory.routes.find(route=>route.method==='DELETE'&&route.path===path)?.service,service);
  for(const path of ['/api/admins/:id','/api/calls/:id','/api/unanswered-questions/:id','/api/orders/:id',
    '/api/parcel-drafts/:id','/api/members/:id','/api/departments/:id','/api/companies/:id'])
    assert.ok(!keys.includes('DELETE '+path));
  assert.ok(baseline.inventory.migrations.at(-1).file.endsWith('066-admin-role-consolidation.sql'));
});
