require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { ActiveCallCountService } = require('../dist/consultations/active-call-count.service');

async function fixture(t, initialCount = 0) {
  let now = 0;
  let activeCount = initialCount;
  const reads = [];
  const values = [[], []];
  const subscriptions = [];
  t.mock.method(performance, 'now', () => now);
  t.mock.method(Client.prototype, 'connect', async () => {});
  t.mock.method(Client.prototype, 'query', async (sql) => {
    assert.equal(sql, 'LISTEN call_sessions_changed');
    return { rows: [] };
  });
  t.mock.method(Client.prototype, 'end', async () => {});
  const repository = {
    activeCount: async () => {
      reads.push({ at: now, count: activeCount });
      return { activeCallCount: activeCount, observedAt: new Date(now).toISOString() };
    },
  };
  const service = new ActiveCallCountService(
    repository,
    { pool: { options: {} } },
    { authenticate: async () => ({}) },
  );
  t.after(async () => {
    for (const subscription of subscriptions) subscription.unsubscribe();
    await service.onModuleDestroy();
  });
  for (const received of values) {
    const stream = await service.stream('test-only-session');
    subscriptions.push(
      stream.subscribe((event) => {
        if (event.type === 'active-call-count') received.push(event.data.activeCallCount);
      }),
    );
  }
  reads.length = 0;
  for (const received of values) received.length = 0;
  return {
    service,
    repository,
    reads,
    values,
    notify(count) {
      activeCount += count;
      for (let i = 0; i < count; i++)
        service.listener.emit('notification', { channel: 'call_sessions_changed', payload: '' });
    },
    at(time) {
      assert.ok(time >= now);
      now = time;
      return service.tick();
    },
  };
}

for (const count of [10, 35]) {
  test(`${count} notifications in one interval share one 1000ms refresh across subscribers`, async (t) => {
    const f = await fixture(t);
    f.notify(count);
    await f.at(999);
    assert.deepEqual(f.reads, []);
    await f.at(1000);
    assert.deepEqual(f.reads, [{ at: 1000, count }]);
    assert.deepEqual(f.values, [[count], [count]]);
  });
}

test('notifications across four 100ms intervals produce four shared snapshots', async (t) => {
  const f = await fixture(t);
  for (const [time, count] of [
    [100, 8],
    [200, 9],
    [300, 9],
    [400, 9],
  ]) {
    f.notify(count);
    await f.at(time - 1);
    assert.equal(f.reads.length, time / 100 - 1);
    await f.at(time);
  }
  assert.deepEqual(f.reads, [
    { at: 100, count: 8 },
    { at: 200, count: 17 },
    { at: 300, count: 26 },
    { at: 400, count: 35 },
  ]);
  assert.deepEqual(f.values, [
    [8, 17, 26, 35],
    [8, 17, 26, 35],
  ]);
  await f.at(1000);
  assert.equal(f.reads.length, 4);
});

for (const [initialCount, interval] of [
  [100, 100],
  [101, 1000],
]) {
  test(`${initialCount} active calls use the ${interval}ms interval`, async (t) => {
    const f = await fixture(t, initialCount);
    f.notify(1);
    await f.at(interval - 1);
    assert.deepEqual(f.reads, []);
    await f.at(interval);
    assert.deepEqual(f.reads, [{ at: interval, count: initialCount + 1 }]);
    assert.deepEqual(f.values, [[initialCount + 1], [initialCount + 1]]);
  });
}

test('later ticks reuse an in-flight refresh while notifications continue', async (t) => {
  const f = await fixture(t);
  const original = f.repository.activeCount;
  const gate = Promise.withResolvers();
  let reads = 0;
  f.repository.activeCount = async () => {
    reads++;
    await gate.promise;
    return original();
  };
  try {
    f.notify(1);
    const first = f.at(100);
    assert.equal(reads, 1);
    f.notify(1);
    const second = f.at(200);
    assert.equal(reads, 1);
    gate.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(f.reads, [{ at: 200, count: 2 }]);
    assert.deepEqual(f.values, [[2], [2]]);
  } finally {
    gate.resolve();
  }
});
