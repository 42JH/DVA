const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { Pool } = require('pg');
const { readFileSync } = require('node:fs');
const { ParcelDraftRetentionWorker } = require('../dist/orders/parcel-draft-retention.worker');
const { restoreLegacyDraftBindings, requestParcelDraftCommand } = require('@dva/events/parcel-drafts.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = process.env.CUSTOMER_AUTH_TOKEN;
const url = 'http://consultation-draft-app:3004';
const query = (p, sql) => p.query(sql).then(r => r.rows);

test('055 owner startup restores every historical snapshot, preserves source rows and prunes migration-only phone copies', async t => {
  assert.equal(process.env.PGDATABASE, 'dva_parcel_draft_test');
  const pools = Object.fromEntries(['monolith', 'order', 'consultation'].map(owner => [owner, new Pool({ host: owner + '-db', user: owner + '_app' })]));
  t.after(() => Promise.all(Object.values(pools).map(p => p.end())));
  for (let i = 0;; i++) {
    try { if ((await fetch('http://order-draft-app:3002/order/health')).ok) break; } catch {}
    assert.ok(i < 200, 'order starts only after legacy bindings and cleanup complete'); await delay(100);
  }
  async function snapshots() {
    const values = await Promise.all([pools.monolith, pools.order].map(p => query(p, 'SELECT * FROM order_parcel_drafts ORDER BY legacy_order_seq,legacy_order_parcel_seq')));
    for (const rows of values) {
      assert.equal(rows.length, 7);
      assert.equal(new Set(rows.map(r => r.client_parcel_id)).size, rows.length);
      for (const r of rows) { assert.match(r.client_parcel_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); delete r.client_parcel_id; }
    }
    assert.deepEqual(values[1], values[0], 'all draft fields except independently generated UUIDs');
    const rows = values[1];
    assert.equal(rows.find(r => r.legacy_order_seq === 100).call_session_seq, 200);
    for (const id of [101, 104, 105]) assert.equal(rows.find(r => r.legacy_order_seq === id).call_session_seq, null);
    assert.equal(rows.find(r => r.legacy_order_seq === 102).caller_phone_number, null);
    assert.equal(rows.find(r => r.legacy_order_seq === 103).caller_phone_number, 'old unrestricted phone text');
    assert.equal(rows.find(r => r.legacy_order_parcel_seq === 1001).status, 'CANCELLED');
    const empty = rows.find(r => r.legacy_order_seq === 105);
    assert.equal(empty.legacy_order_parcel_seq, null); assert.equal(empty.parcel_data.smallBoxCount, 0); assert.equal(empty.parcel_data.origin.name, null);
    assert.equal(rows.some(r => r.legacy_order_seq === 106), false);
  }
  await snapshots();
  for (const table of ['orders', 'order_parcels'])
    assert.deepEqual(await query(pools.order, `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`),
      await query(pools.monolith, `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`), 'original ' + table + ' unchanged');
  assert.deepEqual(await query(pools.consultation, 'SELECT * FROM call_sessions ORDER BY call_session_seq'), await query(pools.monolith, 'SELECT * FROM call_sessions ORDER BY call_session_seq'));
  assert.equal((await query(pools.consultation, 'SELECT count(*)::int AS n FROM legacy_parcel_draft_call_snapshots'))[0].n, 0);
  assert.equal((await query(pools.order, 'SELECT count(*)::int AS n FROM legacy_parcel_draft_bindings'))[0].n, 0);
  assert.equal((await query(pools.order, 'SELECT completed FROM parcel_draft_migration_state'))[0].completed, true);
  for (const owner of ['order', 'consultation']) for (const table of ['inbox_events', 'outbox_events'])
    assert.equal((await query(pools[owner], `SELECT count(*)::int AS n FROM ${table}`))[0].n, 0, 'no permanent phone inbox/outbox copies');
  const database = { pool: pools.order, transaction: async work => {
    const c = await pools.order.connect();
    try { await c.query('BEGIN'); const value = await work(c); await c.query('COMMIT'); return value; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } };
  await restoreLegacyDraftBindings(database, 'http://unreachable.invalid', 'irrelevant-after-completion');
  await snapshots();
  for (const [host, path] of [[url, '/internal/legacy-draft-call-bindings/read'], ['http://order-draft-app:3002', '/internal/call-draft-deletion-check']]) {
    assert.equal((await fetch(host + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(host + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: '{}' })).status, 422);
    const docs = await (await fetch(host + (host === url ? '/consultation/docs-json' : '/order/docs-json'))).json();
    assert.ok(!Object.keys(docs.paths).some(p => p.includes('/internal/')));
  }
  const read = { eventId: randomUUID(), source: 'order', eventType: 'LegacyDraftCallBindingsReadRequested', payload: { orderSeqs: [100] } };
  const expectedBindings = await query(pools.monolith, `SELECT order_seq AS "orderSeq",CASE WHEN count(*)=1 THEN min(call_session_seq) END AS "callSessionSeq",
    CASE WHEN count(*)=1 THEN min(caller_phone_number) END AS "callerPhoneNumber" FROM call_sessions GROUP BY order_seq`);
  async function reset() {
    await pools.order.query('UPDATE order_parcel_drafts SET call_session_seq=NULL,caller_phone_number=NULL; UPDATE parcel_draft_migration_state SET completed=false; DELETE FROM legacy_parcel_draft_bindings; INSERT INTO legacy_parcel_draft_bindings SELECT DISTINCT legacy_order_seq,false FROM order_parcel_drafts;');
    await pools.consultation.query('DELETE FROM legacy_parcel_draft_call_snapshots; UPDATE parcel_draft_call_snapshot_state SET pruned=false WHERE singleton');
    for (const b of expectedBindings) await pools.consultation.query('INSERT INTO legacy_parcel_draft_call_snapshots VALUES($1,$2,$3)', [b.orderSeq, b.callSessionSeq, b.callerPhoneNumber]);
  }
  let mode = 'valid', readCalls = 0, pruneCalls = 0, sawRead;
  const proxy = createServer(async (req, res) => {
    try {
      const parts = []; for await (const p of req) parts.push(p);
      const body = Buffer.concat(parts); const input = JSON.parse(body);
      if (input.eventType === 'LegacyDraftCallBindingsReadRequested') {
        readCalls++; if (mode === 'pause-read') { sawRead(); return; }
      } else pruneCalls++;
      const r = await fetch(url + req.url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body });
      const text = await r.text();
      if (mode === 'lose-prune' && input.eventType === 'LegacyDraftCallBindingsPruneRequested') { req.socket.destroy(); return; }
      res.writeHead(r.status, { 'Content-Type': 'application/json' }).end(text);
    } catch { res.destroy(); }
  });
  await new Promise(resolve => proxy.listen(0, '0.0.0.0', resolve));
  const proxyUrl = 'http://127.0.0.1:' + proxy.address().port;
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  async function killClaimant(phase) {
    const saw = phase === 'read' ? new Promise(resolve => sawRead = resolve) : null;
    const child = fork(__dirname + '/parcel-draft-migration-claimant.cjs', [], { env: { ...process.env, BINDING_URL: proxyUrl, CLAIM_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    t.after(() => child.kill('SIGKILL'));
    const timeout = AbortSignal.timeout(15000);
    if (saw) await Promise.race([saw, once(child, 'exit').then(() => { throw new Error('claimant stopped before read'); }), new Promise((_, reject) => timeout.addEventListener('abort', () => reject(new Error('claimant read timeout')), { once: true }))]);
    else assert.equal((await once(child, 'message', { signal: timeout }))[0], 'committed');
    const killed = once(child, 'exit'); child.kill('SIGKILL'); assert.equal((await killed)[1], 'SIGKILL');
    proxy.closeAllConnections();
  }
  await t.test('a pending order restore cannot overwrite bindings from an already-pruned consultation snapshot', async () => {
    const closed = await fetch(url + '/internal/legacy-draft-call-bindings/read', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify(read) });
    assert.equal(closed.status, 409); assert.equal((await closed.json()).error, 'LEGACY_DRAFT_SNAPSHOT_CLOSED');
    await pools.order.query('UPDATE parcel_draft_migration_state SET completed=false; INSERT INTO legacy_parcel_draft_bindings VALUES(100,false)');
    await assert.rejects(restoreLegacyDraftBindings(database, url, token));
    await snapshots();
    assert.equal((await query(pools.order, 'SELECT completed FROM legacy_parcel_draft_bindings WHERE legacy_order_seq=100'))[0].completed, false);
  });
  await t.test('actual SIGKILL before COMMIT leaves pending markers and the immutable source snapshot', async () => {
    await reset(); mode = 'pause-read'; await killClaimant('read'); mode = 'valid';
    assert.equal((await query(pools.order, 'SELECT count(*)::int AS n FROM legacy_parcel_draft_bindings WHERE completed'))[0].n, 0);
    assert.equal((await query(pools.order, 'SELECT count(*)::int AS n FROM order_parcel_drafts WHERE call_session_seq IS NOT NULL'))[0].n, 0);
    await restoreLegacyDraftBindings(database, proxyUrl, token); await snapshots();
  });
  await t.test('actual SIGKILL after COMMIT resumes cleanup without reapplying or nulling bindings', async () => {
    await reset(); mode = 'valid'; await killClaimant('committed');
    const count = readCalls;
    await restoreLegacyDraftBindings(database, proxyUrl, token); assert.equal(readCalls, count); await snapshots();
  });
  await t.test('lost cleanup ACK retries only cleanup after the source phone snapshots are gone', async () => {
    await reset(); mode = 'lose-prune'; await assert.rejects(restoreLegacyDraftBindings(database, proxyUrl, token));
    assert.equal((await query(pools.consultation, 'SELECT count(*)::int AS n FROM legacy_parcel_draft_call_snapshots'))[0].n, 0);
    const count = readCalls; mode = 'valid'; await restoreLegacyDraftBindings(database, proxyUrl, token);
    assert.equal(readCalls, count); await snapshots();
  });
  await t.test('concurrent bootstraps preserve one durable binding result and idempotent cleanup', async () => {
    await reset();
    await pools.order.query(`INSERT INTO order_parcel_drafts(legacy_order_seq,client_parcel_id,creation_payload,parcel_data,status)
      SELECT n,gen_random_uuid(),'{}','{}','INCOMPLETE' FROM generate_series(710001,710201) n;
      INSERT INTO legacy_parcel_draft_bindings SELECT legacy_order_seq,false FROM order_parcel_drafts WHERE legacy_order_seq>=710001;`);
    const count = readCalls;
    await Promise.all(Array.from({ length: 4 }, () => restoreLegacyDraftBindings(database, proxyUrl, token)));
    assert.ok(readCalls - count >= 3, 'more than two 100-order batches must commit before cleanup');
    assert.equal((await query(pools.order, 'SELECT count(*)::int AS n FROM order_parcel_drafts WHERE legacy_order_seq>=710001 AND (call_session_seq IS NOT NULL OR caller_phone_number IS NOT NULL)'))[0].n, 0);
    await pools.order.query('DELETE FROM order_parcel_drafts WHERE legacy_order_seq>=710001');
    assert.ok(pruneCalls >= 4); await snapshots();
  });
  // A closed snapshot must never be interpreted as zero historical calls after a partial restore.
  await assert.rejects(requestParcelDraftCommand(url + '/internal/legacy-draft-call-bindings/read', token, read));
  await t.test('source retention cutoff, 100-row batches and locked rows preserve current copies without extending old snapshots', async () => {
    const source = readFileSync('/reference-retention.ts', 'utf8').match(/DELETE FROM order_parcel_drafts WHERE draft_seq IN \([\s\S]*?SKIP LOCKED\)/)[0];
    const seed = `INSERT INTO order_parcel_drafts(legacy_order_seq,client_parcel_id,creation_payload,parcel_data,status,retention_started_at,created_at,updated_at,deleted_at)
      SELECT n,gen_random_uuid(),'{}','{}','INCOMPLETE','2000-01-01Z','2050-01-01Z','2050-02-01Z','2050-03-01Z' FROM generate_series(700001,700201) n;
      INSERT INTO order_parcel_drafts(legacy_order_seq,client_parcel_id,creation_payload,parcel_data,status,retention_started_at,created_at)
      VALUES(700202,gen_random_uuid(),'{}','{}','INCOMPLETE','2050-01-01Z','2000-01-01Z');`;
    const held = [];
    try {
      for (const owner of ['monolith', 'order']) {
        await pools[owner].query(seed);
        const c = await pools[owner].connect(); held.push(c); await c.query('BEGIN');
        await c.query('SELECT 1 FROM order_parcel_drafts WHERE legacy_order_seq=700001 FOR KEY SHARE');
      }
      const worker = new ParcelDraftRetentionWorker(database, { get: () => 'test' });
      const ids = async p => (await query(p, 'SELECT legacy_order_seq FROM order_parcel_drafts ORDER BY legacy_order_seq')).map(r => r.legacy_order_seq);
      for (let i = 0; i < 3; i++) {
        const before = (await ids(pools.order)).length;
        await pools.monolith.query(source); await worker.run();
        assert.deepEqual(await ids(pools.order), await ids(pools.monolith));
        assert.equal(before - (await ids(pools.order)).length, i < 2 ? 100 : 1);
      }
      assert.ok((await ids(pools.order)).includes(700001)); assert.ok((await ids(pools.order)).includes(700202));
      for (const c of held) { await c.query('ROLLBACK'); c.release(); } held.length = 0;
      await pools.monolith.query(source); await worker.run();
      assert.deepEqual(await ids(pools.order), await ids(pools.monolith));
      assert.ok(!(await ids(pools.order)).includes(700001)); assert.ok((await ids(pools.order)).includes(700202));
      await worker.onModuleDestroy();
    } finally { for (const c of held) { await c.query('ROLLBACK'); c.release(); } }
  });
});
