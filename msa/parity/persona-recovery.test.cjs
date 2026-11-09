const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { readFileSync } = require('node:fs');

test('production workers resume the exact pending publication after actual application SIGKILL', async () => {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.PGDATABASE, 'dva_webhook_test');
  const before = JSON.parse(readFileSync('/app/service/test/persona-before-restart.json', 'utf8'));
  const started = Date.now();
  await Promise.all(['monolith', 'operations'].map(async (side) => {
    const db = new Pool({ host: side + '-db', connectionTimeoutMillis: 2000 });
    try {
      const control = await fetch(`http://persona-fixture:8000/${side}/__control`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.AI_PERSONA_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshStatus: 202 }),
      });
      assert.equal(control.status, 204);
      const pending = before[side].tables.ai_persona_versions.find((row) => row.status === 'PENDING');
      assert.equal(pending.apply_error_code, 'AI_UNAVAILABLE');
      const prior = before[side].peer.notifications.filter((event) => event.applicationId === pending.application_id);
      assert.ok(prior.length >= 1);
      let recovered;
      for (let attempt = 0; ; attempt++) {
        recovered = (await db.query('SELECT * FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [pending.ai_persona_version_seq])).rows[0];
        if (recovered.apply_error_code === null) break;
        assert.ok(attempt < 90, side + ' worker did not recover within its 30s claim interval');
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      assert.equal(recovered.status, 'PENDING', 'refresh ACK alone must never activate settings');
      assert.equal(recovered.application_id, pending.application_id);
      assert.ok(recovered.last_notified_at.getTime() >= started - 3000 && recovered.last_notified_at.getTime() <= Date.now());
      const peerResponse = await fetch(`http://persona-fixture:8000/${side}/__state`, { headers: { Authorization: 'Bearer ' + process.env.AI_PERSONA_TOKEN } });
      assert.equal(peerResponse.status, 200);
      const peer = await peerResponse.json();
      const retried = peer.notifications.filter((event) => event.applicationId === pending.application_id);
      assert.ok(retried.length > prior.length);
      for (const event of retried) assert.deepEqual(event, { aiPersonaVersionSeq: pending.ai_persona_version_seq, applicationId: pending.application_id });
      for (const [table, order] of [['ai_personas', 'ai_persona_seq'], ['ai_persona_versions', 'ai_persona_version_seq'], ['ai_persona_drafts', 'ai_persona_seq'], ['audit_logs', 'audit_log_seq']]) {
        const actual = JSON.parse(JSON.stringify((await db.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows));
        const expected = structuredClone(before[side].tables[table]);
        if (table === 'ai_persona_versions') {
          const old = expected.find((row) => row.ai_persona_version_seq === pending.ai_persona_version_seq);
          old.apply_error_code = null;
          old.last_notified_at = recovered.last_notified_at.toISOString();
        }
        assert.deepEqual(actual, expected, side + ' full persisted ' + table);
      }
    } finally { await db.end(); }
  }));
});
