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
    for (const actor of [99])
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
        401,
        'UNAUTHORIZED',
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

  require('./ai-settings-migrations.cjs').personaHead(suite);

  test('OPERATOR administrators create, edit and publish with their own identity and active sessions', async () => {
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
