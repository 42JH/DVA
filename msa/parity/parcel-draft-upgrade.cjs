const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { Pool } = require('pg');
assert.equal(process.env.PGDATABASE, 'dva_parcel_draft_test');
const pools = Object.fromEntries(['monolith', 'order', 'consultation'].map(owner => [owner, new Pool({ host: owner + '-db', user: owner + '_app' })]));
async function apply(pool, text) {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await c.query(text); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}
(async () => {
  const referenceFiles = readdirSync('/reference-migrations').filter(n => /^\d{3}-.*\.sql$/.test(n)).sort();
  const ownerFiles = {};
  const upgrade = { order: '004-parcel-drafts.sql', consultation: '008-order-intake.sql' };
  for (const file of referenceFiles.filter(n => n < '055-'))
    await apply(pools.monolith, readFileSync('/reference-migrations/' + file, 'utf8'));
  for (const owner of ['order', 'consultation']) {
    const xml = readFileSync('/changelog/' + owner + '/db.changelog.xml', 'utf8');
    const files = [...xml.matchAll(/<sqlFile path="([^"]+)"/g)].map(m => m[1]);
    const boundary = files.indexOf(upgrade[owner]);
    assert.ok(boundary > 0, owner + ' has an explicit 055 upgrade boundary');
    ownerFiles[owner] = files;
    for (const file of files.slice(0, boundary)) await apply(pools[owner], readFileSync('/changelog/' + owner + '/' + file, 'utf8'));
  }
  const orders = readFileSync('/fixtures/parcel-draft-orders-fixture.sql', 'utf8');
  const calls = readFileSync('/fixtures/parcel-draft-calls-fixture.sql', 'utf8');
  for (const owner of ['monolith', 'order']) await pools[owner].query(orders);
  for (const owner of ['monolith', 'consultation']) await pools[owner].query(calls);
  for (const [owner, file] of [['monolith', '/reference-migrations/055-parcel-draft-intake.sql'],
    ['order', '/changelog/order/004-parcel-drafts.sql'], ['consultation', '/changelog/consultation/008-order-intake.sql']])
    await apply(pools[owner], readFileSync(file, 'utf8'));
  for (const file of referenceFiles.filter(n => n > '055-parcel-draft-intake.sql'))
    await apply(pools.monolith, readFileSync('/reference-migrations/' + file, 'utf8'));
  for (const owner of ['order', 'consultation']) {
    const files = ownerFiles[owner];
    for (const file of files.slice(files.indexOf(upgrade[owner]) + 1))
      await apply(pools[owner], readFileSync('/changelog/' + owner + '/' + file, 'utf8'));
  }
  console.log('Pre-055 fixtures upgraded through the current reference and owner migrations');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => Promise.all(Object.values(pools).map(p => p.end())));
