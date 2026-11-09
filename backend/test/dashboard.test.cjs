require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DashboardQueryDto } = require('../dist/dashboard/dto/dashboard-query.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const pipe = createValidationPipe();
const validate = (query) => pipe.transform(query, { type: 'query', metatype: DashboardQueryDto });

test('dashboard customer filter defaults to ALL and accepts only the three explicit scopes', async () => {
  assert.equal((await validate({})).customerType, 'ALL');
  for (const customerType of ['ALL', 'NEW', 'EXISTING'])
    assert.equal((await validate({ customerType })).customerType, customerType);
});

test('dashboard filter rejects repeated, empty, coerced and removed date/pagination conditions', async () => {
  for (const query of [
    { customerType: '' },
    { customerType: null },
    { customerType: true },
    { customerType: 1 },
    { customerType: 'all' },
    { customerType: 'UNKNOWN' },
    { customerType: ['NEW', 'EXISTING'] },
    { from: '2026-11-04' },
    { to: '2026-11-05' },
    { limit: '20' },
    { offset: '0' },
  ])
    await assert.rejects(() => validate(query), { status: 400 });
});
