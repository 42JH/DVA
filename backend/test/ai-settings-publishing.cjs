module.exports = function registerAiSettingsPublishing(suite) {
  const {
    test,
    create,
    data,
    saveVersion,
    error,
    call,
    serviceCall,
    activate,
    assert,
    report,
    pool,
    runtime,
    options,
    input,
    actorIds,
    randomUUID,
  } = suite;
  test('automatic HEAD: publish validates authority, current HEAD identity and stale editing bases', async () => {
    const first = await create(),
      other = await create();
    const second = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 1, name: '현재 HEAD' }),
    );
    for (const actor of [1])
      await error(
        await call(
          'POST',
          '/api/personas/' + first.aiPersonaSeq + '/activate',
          {
            aiPersonaVersionSeq: second.aiPersonaVersionSeq,
            expectedVersion: 2,
          },
          actor,
        ),
        403,
        'FORBIDDEN',
      );
    await error(
      await serviceCall('POST', '/api/personas/' + first.aiPersonaSeq + '/activate', {
        aiPersonaVersionSeq: second.aiPersonaVersionSeq,
        expectedVersion: 2,
      }),
      403,
      'FORBIDDEN',
    );
    await error(await activate(first), 409, 'VERSION_CONFLICT');
    await error(await activate(first, 2), 409, 'VERSION_CONFLICT');
    await error(
      await call('POST', '/api/personas/' + first.aiPersonaSeq + '/activate', {
        aiPersonaVersionSeq: other.aiPersonaVersionSeq,
        expectedVersion: 2,
      }),
      404,
      'NOT_FOUND',
    );
    await error(
      await call('POST', '/api/personas/' + first.aiPersonaSeq + '/activate', {
        aiPersonaVersionSeq: second.aiPersonaVersionSeq,
        expectedVersion: '2',
      }),
      400,
      'INVALID_REQUEST',
    );
    await error(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 1, name: '과거 편집' }),
      409,
      'VERSION_CONFLICT',
    );
    await error(
      await call('PUT', '/api/personas/' + first.aiPersonaSeq + '/head', {
        aiPersonaVersionSeq: first.aiPersonaVersionSeq,
        expectedVersion: 2,
      }),
      404,
      'NOT_FOUND',
    );
    const detail = await data(await call('GET', '/api/personas/' + first.aiPersonaSeq));
    assert.equal(detail.headVersion.aiPersonaVersionSeq, second.aiPersonaVersionSeq);
    assert.equal(detail.activeVersion, null);
    assert.equal(detail.pendingVersion, null);
  });

  test('automatic HEAD: publish failure and replacement remain separate from later saves', async () => {
    const first = await create();
    await data(await report(await data(await activate(first), 202)));
    const second = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 1, name: '대기 v2' }),
    );
    const pending = await data(await activate(second), 202);
    const third = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 2, name: 'HEAD v3' }),
    );
    await data(await report(pending, { result: 'FAILED', errorCode: 'APPLY_FAILED' }));
    const detail = await data(await call('GET', '/api/personas/' + first.aiPersonaSeq));
    assert.equal(detail.headVersion.aiPersonaVersionSeq, third.aiPersonaVersionSeq);
    assert.equal(detail.activeVersion.aiPersonaVersionSeq, first.aiPersonaVersionSeq);
    assert.equal(detail.activeVersion.createdByAdminUserName, '설정 테스트 관리자');
    assert.equal(detail.pendingVersion.aiPersonaVersionSeq, second.aiPersonaVersionSeq);
    assert.equal(detail.pendingVersion.applicationId, pending.applicationId);
    assert.equal(detail.pendingVersion.applyErrorCode, 'APPLY_FAILED');
    assert.equal(detail.activeVersionSeq, detail.activeVersion.aiPersonaVersionSeq);
    assert.equal(detail.pendingVersionSeq, detail.pendingVersion.aiPersonaVersionSeq);
    await error(await activate(second, 3), 409, 'VERSION_CONFLICT');
    const replacement = await data(await activate(third), 202);
    await error(await report(pending), 409, 'VERSION_CONFLICT');
    await data(await report(replacement));
  });

  test('automatic HEAD: a failed save keeps the latest version and publish unchanged', async () => {
    const first = await create();
    await data(await report(await data(await activate(first), 202)));
    const second = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 1, name: 'HEAD v2' }),
    );
    const pending = await data(await activate(second), 202);
    const { AuditService } = require('../dist/audit/audit.service');
    const audit = suite.app.get(AuditService),
      original = audit.recordSuccess;
    audit.recordSuccess = async (event, client) => {
      if (event.action === 'PERSONA_UPDATED') throw new Error('test-only failure');
      return original.call(audit, event, client);
    };
    try {
      await error(
        await saveVersion(first.aiPersonaSeq, { expectedVersion: 2, name: '실패 v3' }),
        500,
        'INTERNAL_ERROR',
      );
    } finally {
      audit.recordSuccess = original;
    }
    const detail = await data(await call('GET', '/api/personas/' + first.aiPersonaSeq));
    assert.equal(detail.headVersion.aiPersonaVersionSeq, second.aiPersonaVersionSeq);
    assert.equal(detail.activeVersionSeq, first.aiPersonaVersionSeq);
    assert.equal(detail.pendingVersion.applicationId, pending.applicationId);
    assert.equal(
      (
        await pool.query('SELECT count(*) FROM ai_persona_versions WHERE ai_persona_seq=$1', [
          first.aiPersonaSeq,
        ])
      ).rows[0].count,
      '2',
    );
    await data(await report(pending));
  });

  test('automatic HEAD: concurrent save and publish never silently select an unseen version', async () => {
    const active = await create();
    await data(await report(await data(await activate(active), 202)));
    const target = await create();
    const [savedResponse, publishResponse] = await Promise.all([
      saveVersion(target.aiPersonaSeq, { expectedVersion: 1, name: '새 HEAD v2' }),
      activate(target),
    ]);
    const saved = await data(savedResponse);
    assert.ok([202, 409].includes(publishResponse.status));
    if (publishResponse.status === 202) {
      const pending = await data(publishResponse, 202);
      assert.equal(pending.aiPersonaVersionSeq, target.aiPersonaVersionSeq);
      assert.equal((await data(await runtime('PENDING'))).applicationId, pending.applicationId);
      await data(await report(pending));
      assert.equal((await data(await runtime())).aiPersonaVersionSeq, target.aiPersonaVersionSeq);
    } else {
      await error(publishResponse, 409, 'VERSION_CONFLICT');
      await error(await runtime('PENDING'), 404, 'NOT_FOUND');
      assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
    }
    const detail = await data(await call('GET', '/api/personas/' + target.aiPersonaSeq));
    assert.equal(detail.headVersion.aiPersonaVersionSeq, saved.aiPersonaVersionSeq);
  });

  require('./ai-settings-migrations.cjs').personaHead(suite);

  test('automatic HEAD: type saves advance their heads without changing the published call version', async () => {
    const friendly1 = await create(),
      fast1 = await create();
    const friendly2 = await data(
      await saveVersion(friendly1.aiPersonaSeq, { expectedVersion: 1, name: '친절 v2' }),
    );
    const friendly3 = await data(
      await saveVersion(friendly1.aiPersonaSeq, { expectedVersion: 2, name: '친절 v3' }),
    );
    const fast2 = await data(
      await saveVersion(fast1.aiPersonaSeq, { expectedVersion: 1, name: '빠른 v2' }),
    );
    assert.equal(
      (await data(await call('GET', `/api/personas/${friendly1.aiPersonaSeq}`))).headVersion
        .aiPersonaVersionSeq,
      friendly3.aiPersonaVersionSeq,
    );
    await data(await report(await data(await activate(fast2), 202)));
    const friendly4 = await data(
      await saveVersion(friendly1.aiPersonaSeq, {
        expectedVersion: friendly3.version,
        name: '친절 v4',
      }),
    );
    const fast3 = await data(
      await saveVersion(fast1.aiPersonaSeq, { expectedVersion: fast2.version, name: '빠른 v3' }),
    );
    const fast = await data(await call('GET', `/api/personas/${fast1.aiPersonaSeq}`));
    assert.equal(fast.headVersion.aiPersonaVersionSeq, fast3.aiPersonaVersionSeq);
    assert.equal(fast.activeVersion.aiPersonaVersionSeq, fast2.aiPersonaVersionSeq);
    assert.equal(fast.pendingVersion, null);
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, fast2.aiPersonaVersionSeq);
    await error(await runtime('PENDING'), 404, 'NOT_FOUND');
    await error(await activate(friendly2, friendly4.version), 409, 'VERSION_CONFLICT');
    await data(await report(await data(await activate(friendly4), 202)));
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, friendly4.aiPersonaVersionSeq);
    await data(await report(await data(await activate(fast3), 202)));
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, fast3.aiPersonaVersionSeq);
    const listed = await (await call('GET', '/api/personas?limit=100')).json();
    const row = listed.data.find((p) => p.aiPersonaSeq === friendly1.aiPersonaSeq);
    assert.equal(row.headVersion.aiPersonaVersionSeq, friendly4.aiPersonaVersionSeq);
    assert.equal(row.activeVersion, null);
    assert.equal(row.pendingVersion, null);
  });

  test('automatic HEAD: an accepted publish keeps its version and UUID when a newer head is saved', async () => {
    const first = await create();
    await data(await report(await data(await activate(first), 202)));
    const second = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 1, name: 'publish v2' }),
    );
    const pending = await data(await activate(second), 202);
    const third = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 2, name: '저장만 v3' }),
    );
    const waiting = await data(await call('GET', `/api/personas/${first.aiPersonaSeq}`));
    assert.equal(waiting.headVersion.aiPersonaVersionSeq, third.aiPersonaVersionSeq);
    assert.equal(waiting.activeVersion.aiPersonaVersionSeq, first.aiPersonaVersionSeq);
    assert.equal(waiting.pendingVersion.aiPersonaVersionSeq, second.aiPersonaVersionSeq);
    assert.equal(waiting.pendingVersion.applicationId, pending.applicationId);
    assert.equal(waiting.pendingVersion.createdByAdminUserName, '설정 테스트 관리자');
    await data(await report(pending, { activeCallCount: 2 }));
    const applied = await data(await call('GET', `/api/personas/${first.aiPersonaSeq}`));
    assert.equal(applied.headVersion.aiPersonaVersionSeq, third.aiPersonaVersionSeq);
    assert.equal(applied.activeVersion.aiPersonaVersionSeq, second.aiPersonaVersionSeq);
    assert.equal(applied.pendingVersion, null);
    const next = await data(await activate(third), 202);
    assert.notEqual(next.applicationId, pending.applicationId);
    await data(await report(next));
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, third.aiPersonaVersionSeq);
  });

  test('SUPERVISOR developers create, edit and publish with their own identity and active sessions', async () => {
    assert.deepEqual(await data(await call('GET', '/api/ai/options', undefined, 2)), options);
    const first = await data(await call('POST', '/api/personas', input(), 2), 201);
    assert.equal(first.createdByAdminUserSeq, actorIds[2]);
    const second = await data(
      await saveVersion(first.aiPersonaSeq, { expectedVersion: 1, name: '개발자 수정' }, 2),
    );
    assert.equal(second.version, 2);
    assert.equal(second.createdByAdminUserSeq, actorIds[2]);
    const published = await data(
      await call(
        'POST',
        `/api/personas/${first.aiPersonaSeq}/activate`,
        {
          aiPersonaVersionSeq: second.aiPersonaVersionSeq,
          expectedVersion: 2,
        },
        2,
      ),
      202,
    );
    assert.equal(published.aiPersonaVersionSeq, second.aiPersonaVersionSeq);
    assert.equal(published.status, 'PENDING');
    try {
      await pool.query("UPDATE admin_users SET status='INACTIVE' WHERE admin_user_seq=$1", [
        actorIds[2],
      ]);
      for (const [method, path, body] of [
        ['GET', '/api/ai/options', undefined],
        ['POST', '/api/personas', input()],
        ['PATCH', `/api/personas/${first.aiPersonaSeq}`, { expectedVersion: 2, name: '금지' }],
        [
          'POST',
          `/api/personas/${first.aiPersonaSeq}/versions`,
          { expectedVersion: 2, expectedDraftRevision: randomUUID() },
        ],
        [
          'POST',
          `/api/personas/${first.aiPersonaSeq}/activate`,
          { aiPersonaVersionSeq: second.aiPersonaVersionSeq, expectedVersion: 2 },
        ],
      ])
        await error(await call(method, path, body, 2), 401, 'UNAUTHORIZED');
    } finally {
      await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
        actorIds[2],
      ]);
    }
  });
};
