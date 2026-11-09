module.exports = function registerPersonaPredecessor(suite) {
  const { test, assert, pool, create, data, error, activate, report, saveVersion } = suite;
  let first, second, other;
  const row = async (version) =>
    (
      await pool.query('SELECT * FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [
        version.aiPersonaVersionSeq,
      ])
    ).rows[0];

  test('successful activation records the exact preceding version including a same-persona version change', async () => {
    await pool.query(
      "UPDATE ai_persona_versions SET status='INACTIVE' WHERE status IN ('ACTIVE','PENDING')",
    );
    first = await create({ name: '비교 v1' });
    await data(await report(await data(await activate(first), 202)));
    assert.equal((await row(first)).previous_active_version_seq, null);
    second = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 1, name: '비교 v2' }),
    );
    const pending = await data(await activate(second), 202);
    assert.equal((await row(first)).status, 'ACTIVE');
    await data(await report(pending, { result: 'FAILED', errorCode: 'APPLY_FAILED' }));
    assert.equal((await row(first)).status, 'ACTIVE');
    assert.equal((await row(second)).previous_active_version_seq, null);
    await data(await report(pending));
    const active = await row(second);
    assert.equal(active.previous_active_version_seq, first.aiPersonaVersionSeq);
    assert.equal(active.ai_persona_seq, first.aiPersonaSeq);
    await data(await report(pending));
    assert.deepEqual(await row(second), active);
  });

  test('reactivation preserves predecessor identity when applied_at is cleared and audits are purged', async () => {
    other = await create({ name: '교체 버전' });
    await data(await report(await data(await activate(other), 202)));
    assert.equal((await row(other)).previous_active_version_seq, second.aiPersonaVersionSeq);
    const pending = await data(await activate(second), 202);
    assert.equal((await row(second)).applied_at, null);
    assert.equal((await row(other)).status, 'ACTIVE');
    assert.equal((await row(other)).previous_active_version_seq, second.aiPersonaVersionSeq);
    await data(await report(pending));
    assert.equal((await row(second)).previous_active_version_seq, other.aiPersonaVersionSeq);
    await pool.query(
      "DELETE FROM audit_logs WHERE action='PERSONA_APPLIED' AND target_seq=ANY($1::int[])",
      [[first.aiPersonaVersionSeq, second.aiPersonaVersionSeq, other.aiPersonaVersionSeq]],
    );
    assert.equal((await row(second)).previous_active_version_seq, other.aiPersonaVersionSeq);
  });

  test('activation audit failure rolls back both ACTIVE state and the predecessor pointer', async () => {
    const next = await create({ name: '원자 전환' });
    const pending = await data(await activate(next), 202);
    const before = await row(second);
    const { AuditService } = require('../dist/audit/audit.service');
    const audit = suite.app.get(AuditService);
    const original = audit.recordSuccess;
    audit.recordSuccess = async (event, client) => {
      if (event.action === 'PERSONA_APPLIED') throw new Error('predecessor audit failure');
      return original.call(audit, event, client);
    };
    try {
      await error(await report(pending), 500, 'INTERNAL_ERROR');
    } finally {
      audit.recordSuccess = original;
    }
    assert.deepEqual(await row(second), before);
    assert.equal((await row(next)).status, 'PENDING');
    assert.equal((await row(next)).previous_active_version_seq, null);
    await data(await report(pending));
    assert.equal((await row(next)).previous_active_version_seq, second.aiPersonaVersionSeq);
  });
};
