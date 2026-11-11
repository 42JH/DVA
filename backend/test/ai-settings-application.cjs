const { startTestApp } = require('./helpers/application.cjs');
module.exports = function registerAiSettingsApplication(suite) {
  const {
    test,
    error,
    serviceCall,
    runtime,
    call,
    input,
    assert,
    pool,
    create,
    data,
    activate,
    applicationService,
    notifications,
    report,
    saveVersion,
    randomUUID,
    apps,
    logs,
    actorIds,
    legacyVersion,
  } = suite;
  test('runtime settings and application callbacks enforce dedicated service authentication', async () => {
    for (const headers of [
      { Authorization: undefined },
      { Authorization: 'Bearer incorrect' },
      { Authorization: 'Basic invalid' },
    ])
      await error(
        await serviceCall('GET', '/api/ai/config', undefined, headers),
        401,
        'UNAUTHORIZED',
      );
    await error(await runtime(), 404, 'NOT_FOUND');
    await error(await runtime('INACTIVE'), 400, 'INVALID_REQUEST');
    await error(await call('GET', '/api/ai/config', undefined, 1), 403, 'FORBIDDEN');
    await error(await call('POST', '/api/ai/config/apply-result', {}), 401, 'UNAUTHORIZED');
    await error(await serviceCall('POST', '/api/personas', input()), 403, 'FORBIDDEN');
    for (const [headers, expectedType, expectedStatus] of [
      [{ Authorization: 'Bearer incorrect' }, 'SYSTEM', 401],
      [{}, 'AI', 400],
    ]) {
      const response = await serviceCall('POST', '/api/ai/config/apply-result', {}, headers);
      assert.equal(response.status, expectedStatus);
      const logs = (
        await pool.query('SELECT actor_type,result FROM audit_logs WHERE request_id=$1', [
          response.headers.get('x-request-id'),
        ])
      ).rows;
      assert.deepEqual(logs, [
        { actor_type: expectedType, result: expectedStatus === 401 ? 'DENIED' : 'FAILED' },
      ]);
    }
  });

  test('activation stays pending until the AI acknowledges the new-call configuration, even with active calls', async () => {
    const version = await create();
    const pending = await data(await activate(version), 202);
    assert.equal(pending.status, 'PENDING');
    assert.ok(pending.applicationId);
    assert.equal(pending.appliedAt, null);
    assert.equal(
      (await data(await runtime('PENDING'))).aiPersonaVersionSeq,
      pending.aiPersonaVersionSeq,
    );
    await applicationService().tick();
    assert.ok(
      notifications.some(
        (n) =>
          n.applicationId === pending.applicationId &&
          n.aiPersonaVersionSeq === pending.aiPersonaVersionSeq,
      ),
    );
    await error(await runtime(), 404, 'NOT_FOUND');
    const same = await data(await activate(version), 202);
    assert.equal(same.applicationId, pending.applicationId);
    const active = await data(await report(pending, { activeCallCount: 1 }));
    assert.equal(active.status, 'ACTIVE');
    assert.ok(active.appliedAt);
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
    assert.equal(
      (await data(await call('GET', '/api/ai/config'))).aiPersonaVersionSeq,
      active.aiPersonaVersionSeq,
    );
    assert.equal((await data(await report(pending))).appliedAt, active.appliedAt);
    assert.equal((await data(await activate(version))).status, 'ACTIVE');
    const appliedActor = (
      await pool.query(
        "SELECT actor_type,actor_name,actor_seq FROM audit_logs WHERE action='PERSONA_APPLIED' AND target_seq=$1",
        [active.aiPersonaVersionSeq],
      )
    ).rows;
    assert.deepEqual(appliedActor, [{ actor_type: 'AI', actor_name: 'AI', actor_seq: null }]);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE action='PERSONA_APPLIED' AND target_seq=$1",
          [active.aiPersonaVersionSeq],
        )
      ).rows[0].n,
      1,
    );
  });

  test('saving advances HEAD without publishing and an explicit replacement rejects late acknowledgments', async () => {
    const active = await data(await runtime());
    const saved1 = await data(
      await saveVersion(active.aiPersonaSeq, { expectedVersion: active.version, name: '수정 1' }),
    );
    assert.equal(saved1.status, 'INACTIVE');
    await error(await runtime('PENDING'), 404, 'NOT_FOUND');
    const pending1 = await data(await activate(saved1), 202);
    assert.equal(pending1.status, 'PENDING');
    assert.equal((await data(await runtime())).name, active.name);
    const saved2 = await data(
      await saveVersion(active.aiPersonaSeq, {
        expectedVersion: pending1.version,
        role: '수정 2',
      }),
    );
    assert.equal(saved2.status, 'INACTIVE');
    assert.equal((await data(await runtime('PENDING'))).applicationId, pending1.applicationId);
    const pending2 = await data(await activate(saved2), 202);
    assert.notEqual(pending1.applicationId, pending2.applicationId);
    assert.equal(
      (
        await pool.query('SELECT status FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [
          pending1.aiPersonaVersionSeq,
        ])
      ).rows[0].status,
      'INACTIVE',
    );
    await error(await report(pending1), 409, 'VERSION_CONFLICT');
    const other = await create();
    const replacement = await data(await activate(other), 202);
    await error(await report(pending2), 409, 'VERSION_CONFLICT');
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
    const next = await data(await report(replacement));
    assert.equal(next.aiPersonaSeq, other.aiPersonaSeq);
    assert.equal(
      (
        await pool.query('SELECT status FROM ai_persona_versions WHERE ai_persona_version_seq=$1', [
          active.aiPersonaVersionSeq,
        ])
      ).rows[0].status,
      'INACTIVE',
    );
    const history = await data(await call('GET', `/api/personas/${active.aiPersonaSeq}/versions`));
    assert.deepEqual(
      history.map((v) => v.version),
      [3, 2, 1],
    );
  });

  test('failure keeps the old ACTIVE and retry rotates the application ID without accepting obsolete results', async () => {
    const active = await data(await runtime());
    const source = await create();
    const pending = await data(await activate(source), 202);
    const failed = await data(
      await report(pending, { result: 'FAILED', errorCode: 'APPLY_FAILED' }),
    );
    assert.equal(failed.status, 'PENDING');
    assert.equal(failed.applyErrorCode, 'APPLY_FAILED');
    await data(await report(pending, { result: 'FAILED', errorCode: 'APPLY_FAILED' }));
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE action='PERSONA_APPLY_FAILED' AND target_seq=$1 AND result='FAILED'",
          [source.aiPersonaVersionSeq],
        )
      ).rows[0].n,
      1,
    );
    const retried = await data(await activate(source), 202);
    assert.notEqual(retried.applicationId, pending.applicationId);
    assert.equal(retried.applyErrorCode, null);
    await error(await report(pending), 409, 'VERSION_CONFLICT');
    await data(await report(retried));
    await error(
      await report(retried, { result: 'FAILED', errorCode: 'APPLY_FAILED' }),
      409,
      'VERSION_CONFLICT',
    );
  });

  test('two concurrent applications retain one pending and one active with atomic successful handover', async () => {
    const [a, b] = await Promise.all([create(), create()]);
    const pending = await Promise.all([a, b].map(async (v) => data(await activate(v), 202)));
    const results = await Promise.all(pending.map(report));
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const counts = (
      await pool.query(
        "SELECT status,count(*)::int AS n FROM ai_persona_versions WHERE status IN ('ACTIVE','PENDING') GROUP BY status",
      )
    ).rows;
    assert.deepEqual(counts, [{ status: 'ACTIVE', n: 1 }]);
    const current = await data(await runtime());
    const stale = pending.find((v) => v.aiPersonaVersionSeq !== current.aiPersonaVersionSeq);
    await assert.rejects(
      pool.query(
        "UPDATE ai_persona_versions SET status='ACTIVE',applied_at=clock_timestamp() WHERE ai_persona_version_seq=$1",
        [stale.aiPersonaVersionSeq],
      ),
      (e) => e.code === '23505',
    );
  });

  test('failed audit on applied acknowledgment rolls the entire ACTIVE switch back', async () => {
    const { AuditService } = require('../dist/audit/audit.service');
    const audit = suite.app.get(AuditService),
      original = audit.recordSuccess;
    const previous = await data(await runtime());
    const pending = await data(await activate(await create()), 202);
    audit.recordSuccess = async (event, client) => {
      if (event.action === 'PERSONA_APPLIED') throw new Error('test-only failure');
      return original.call(audit, event, client);
    };
    try {
      await error(await report(pending), 500, 'INTERNAL_ERROR');
    } finally {
      audit.recordSuccess = original;
    }
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, previous.aiPersonaVersionSeq);
    assert.equal((await data(await runtime('PENDING'))).applicationId, pending.applicationId);
    await data(await report(pending));
  });

  test('notification failures remain pending and retries preserve the same request without marking it active', async () => {
    const beforeActive = await data(await runtime());
    const pending = await data(await activate(await create()), 202);
    suite.refreshStatus = 503;
    await applicationService().tick();
    const failed = await data(await runtime('PENDING'));
    assert.equal(failed.applyErrorCode, 'AI_UNAVAILABLE');
    assert.equal(failed.applicationId, pending.applicationId);
    suite.refreshStatus = 202;
    await pool.query(
      "UPDATE ai_persona_versions SET last_notified_at=clock_timestamp()-interval '31 seconds' WHERE ai_persona_version_seq=$1",
      [pending.aiPersonaVersionSeq],
    );
    await applicationService().tick();
    const notified = await data(await runtime('PENDING'));
    assert.equal(notified.applyErrorCode, null);
    assert.equal(notified.status, 'PENDING');
    assert.equal(
      (await data(await runtime())).aiPersonaVersionSeq,
      beforeActive.aiPersonaVersionSeq,
    );
    assert.equal(notifications.filter((n) => n.applicationId === pending.applicationId).length, 2);
  });

  test('a restarted backend resumes pending notifications and concurrent workers claim once', async () => {
    const pending = await data(await runtime('PENDING'));
    await suite.app.close();
    apps.splice(apps.indexOf(suite.app), 1);
    await pool.query(
      "UPDATE ai_persona_versions SET last_notified_at=clock_timestamp()-interval '31 seconds' WHERE ai_persona_version_seq=$1",
      [pending.aiPersonaVersionSeq],
    );
    suite.app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
    suite.base = await suite.app.getUrl();
    await applicationService().tick();
    assert.equal(notifications.filter((n) => n.applicationId === pending.applicationId).length, 3);
    const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
    const repository = suite.app.get(AiSettingsRepository);
    await pool.query(
      "UPDATE ai_persona_versions SET last_notified_at=clock_timestamp()-interval '31 seconds' WHERE ai_persona_version_seq=$1",
      [pending.aiPersonaVersionSeq],
    );
    const claims = await Promise.all([
      repository.claimNotification(),
      repository.claimNotification(),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    await data(await report(pending));
  });

  test('choosing the current ACTIVE cancels a different pending request so the latest intention wins', async () => {
    const active = await data(await runtime());
    const pending = await data(await activate(await create()), 202);
    const detail = await data(await call('GET', `/api/personas/${active.aiPersonaSeq}`));
    const current = await data(await activate(active, detail.latestVersion.version));
    assert.equal(current.applicationId, active.applicationId);
    await error(await runtime('PENDING'), 404, 'NOT_FOUND');
    await error(await report(pending), 409, 'VERSION_CONFLICT');
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
  });

  test('transport failure cannot erase a specific apply error and stale notification results cannot affect its replacement', async () => {
    const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
    const repository = suite.app.get(AiSettingsRepository);
    const pending = await data(await activate(await create()), 202);
    await data(await report(pending, { result: 'FAILED', errorCode: 'INVALID_CONFIG' }));
    await repository.applicationError(
      pending.aiPersonaVersionSeq,
      pending.applicationId,
      'AI_UNAVAILABLE',
    );
    assert.equal((await data(await runtime('PENDING'))).applyErrorCode, 'INVALID_CONFIG');
    const next = await data(await activate(await create()), 202);
    await repository.applicationError(
      pending.aiPersonaVersionSeq,
      pending.applicationId,
      'AI_UNAVAILABLE',
    );
    assert.equal((await data(await runtime('PENDING'))).applicationId, next.applicationId);
    assert.equal((await data(await runtime('PENDING'))).applyErrorCode, null);
    await data(await report(next));
  });

  test('creator names are included in administrator persona responses without leaking into AI configuration', async () => {
    const version = await create();
    assert.equal(version.createdByAdminUserSeq, actorIds[0]);
    assert.equal(version.createdByAdminUserName, '설정 테스트 관리자');
    const updated = await data(
      await saveVersion(version.aiPersonaSeq, { expectedVersion: 1, name: '작성자 확인 버전' }),
    );
    assert.equal(updated.createdByAdminUserName, '설정 테스트 관리자');
    const detail = await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`));
    assert.equal(detail.latestVersion.createdByAdminUserName, '설정 테스트 관리자');
    const listed = await (await call('GET', '/api/personas?limit=100')).json();
    assert.equal(
      listed.data.find((row) => row.aiPersonaSeq === version.aiPersonaSeq).latestVersion
        .createdByAdminUserName,
      '설정 테스트 관리자',
    );
    const versions = await (
      await call('GET', `/api/personas/${version.aiPersonaSeq}/versions`)
    ).json();
    assert.equal(versions.total_count, 2);
    assert.ok(versions.data.every((row) => row.createdByAdminUserName === '설정 테스트 관리자'));
    const pending = await data(await activate(updated), 202);
    assert.equal(pending.createdByAdminUserName, '설정 테스트 관리자');
    assert.equal('createdByAdminUserName' in (await data(await runtime('PENDING'))), false);
    assert.equal('createdByAdminUserName' in (await data(await report(pending))), false);
    assert.equal('createdByAdminUserName' in (await data(await runtime())), false);
  });

  test('creator snapshots survive administrator soft deletion and login ID reuse', async () => {
    const loginId = 'legacy-' + randomUUID();
    const creator = (
      await pool.query(
        "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'삭제 전 작성자','not-for-login','OPERATOR','ACTIVE') RETURNING admin_user_seq",
        [loginId],
      )
    ).rows[0].admin_user_seq;
    // 과거 작성자를 표현하는 DB fixture. 현재 SYSTEM_ADMIN 생성·삭제 권한 정책은 변경하지 않는다.
    const version = await legacyVersion(creator);
    assert.equal(
      (await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`))).latestVersion
        .createdByAdminUserName,
      '삭제 전 작성자',
    );
    assert.equal((await call('DELETE', '/api/admins', { adminUserSeqs: [creator] })).status, 204);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*) FROM admin_users WHERE admin_user_seq=$1 AND deleted_at IS NULL',
          [creator],
        )
      ).rows[0].count,
      '0',
    );
    const rows = await (await call('GET', `/api/personas/${version.aiPersonaSeq}/versions`)).json();
    assert.equal(rows.data[0].createdByAdminUserSeq, creator);
    assert.equal(rows.data[0].createdByAdminUserName, '삭제 전 작성자');
    const replacement = (
      await pool.query(
        "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'새 관리자','not-for-login','OPERATOR','ACTIVE') RETURNING admin_user_seq",
        [loginId],
      )
    ).rows[0].admin_user_seq;
    assert.notEqual(replacement, creator);
    assert.equal(
      (await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`))).latestVersion
        .createdByAdminUserName,
      '삭제 전 작성자',
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_persona_versions' AND column_name='created_by_admin_user_name'",
        )
      ).rows[0].count,
      '1',
    );
  });

  test('unknown legacy creator names remain null and another actor on the same version cannot be misattributed', async () => {
    const version = await legacyVersion(2147483647, false);
    const { AuditService } = require('../dist/audit/audit.service');
    const { DatabaseService } = require('../dist/database/database.service');
    await suite.app.get(DatabaseService).transaction((client) =>
      suite.app.get(AuditService).recordSuccess(
        {
          actorId: actorIds[0],
          targetId: version.aiPersonaVersionSeq,
          targetType: 'AI_PERSONA_VERSION',
          action: 'PERSONA_APPLY_REQUESTED',
          requestId: randomUUID(),
        },
        client,
      ),
    );
    const detail = await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`));
    assert.equal(detail.latestVersion.createdByAdminUserSeq, 2147483647);
    assert.equal(detail.latestVersion.createdByAdminUserName, null);
    const noCreator = await legacyVersion(null, false);
    assert.equal(
      (await data(await call('GET', `/api/personas/${noCreator.aiPersonaSeq}`))).latestVersion
        .createdByAdminUserName,
      null,
    );
  });
};
