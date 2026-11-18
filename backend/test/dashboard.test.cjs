require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DashboardQueryDto } = require('../dist/dashboard/dto/dashboard-query.dto');
const { createValidationPipe } = require('../dist/common/http/validation.pipe');
const { CoalescedReads } = require('../dist/common/coalesced-reads');
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

test('queued reads share an unopened snapshot and later readers observe the next snapshot', async () => {
  const reads = new CoalescedReads();
  const started = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let current = 1;
  const first = reads.read('home', async () => {
    const snapshot = current;
    started.resolve();
    await resume.promise;
    return snapshot;
  });
  const sameBatch = reads.read('home', () => assert.fail('queued request started a second read'));
  assert.equal(first, sameBatch);
  await started.promise;
  current = 2;
  const later = reads.read('home', async () => current);
  assert.notEqual(first, later);
  assert.equal(await reads.read('orders', async () => 'independent'), 'independent');
  resume.resolve();
  assert.deepEqual(await Promise.all([first, sameBatch, later]), [1, 1, 2]);
  assert.equal(await reads.read('home', async () => 3), 3);
});

test('a failed shared read releases the following batch and does not retain an error', async () => {
  const reads = new CoalescedReads();
  const started = Promise.withResolvers();
  const fail = Promise.withResolvers();
  const first = reads.read('orders', async () => {
    started.resolve();
    await fail.promise;
  });
  const rejected = assert.rejects(first, /failed snapshot/);
  await started.promise;
  const next = reads.read('orders', async () => 'fresh');
  fail.reject(new Error('failed snapshot'));
  await rejected;
  assert.equal(await next, 'fresh');
});
