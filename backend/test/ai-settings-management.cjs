module.exports = function registerAiSettingsManagement(suite) {
  const {
    test,
    create,
    data,
    call,
    assert,
    error,
    input,
    token,
    pool,
    actorIds,
    saveVersion,
    options,
  } = suite;
  test('persona reads allow every active administrator while OPERATOR cannot change settings', async () => {
    const version = await create();
    for (const actor of [0, 1, 2]) {
      const listed = await data(await call('GET', '/api/personas?limit=100', undefined, actor));
      assert.ok(listed.some((persona) => persona.aiPersonaSeq === version.aiPersonaSeq));
      assert.equal(
        (await data(await call('GET', `/api/personas/${version.aiPersonaSeq}`, undefined, actor)))
          .aiPersonaSeq,
        version.aiPersonaSeq,
      );
      const history = await data(
        await call('GET', `/api/personas/${version.aiPersonaSeq}/versions`, undefined, actor),
      );
      assert.equal(history[0].aiPersonaVersionSeq, version.aiPersonaVersionSeq);
    }
    for (const actor of [1]) {
      await error(await call('POST', '/api/personas', input(), actor), 403, 'FORBIDDEN');
      await error(
        await call(
          'PATCH',
          `/api/personas/${version.aiPersonaSeq}`,
          { expectedVersion: 1, name: '권한 없음' },
          actor,
        ),
        403,
        'FORBIDDEN',
      );
      await error(
        await call(
          'POST',
          `/api/personas/${version.aiPersonaSeq}/activate`,
          { aiPersonaVersionSeq: version.aiPersonaVersionSeq, expectedVersion: 1 },
          actor,
        ),
        403,
        'FORBIDDEN',
      );
      await error(await call('GET', '/api/ai/options', undefined, actor), 403, 'FORBIDDEN');
    }
    await error(
      await call('GET', '/api/personas', undefined, 99, { Authorization: `Bearer ${token}` }),
      401,
      'UNAUTHORIZED',
    );
    await error(
      await call('POST', '/api/personas', input(), 0, { Origin: undefined }),
      403,
      'FORBIDDEN',
    );
  });

  test('persona creation preserves prompt and full settings in an inactive immutable version', async () => {
    const body = input();
    const v = await data(await call('POST', '/api/personas', body), 201);
    for (const field of Object.keys(body)) assert.deepEqual(v[field], body[field]);
    assert.equal(v.version, 1);
    assert.equal(v.status, 'INACTIVE');
    assert.equal(v.createdByAdminUserSeq, actorIds[0]);
    assert.equal(v.applicationId, null);
    const detail = await data(await call('GET', `/api/personas/${v.aiPersonaSeq}`));
    assert.equal(detail.latestVersion.aiPersonaVersionSeq, v.aiPersonaVersionSeq);
    assert.deepEqual(detail.headVersion, detail.latestVersion);
    assert.equal(detail.activeVersion, null);
    assert.equal(detail.pendingVersion, null);
    assert.equal(detail.activeVersionSeq, null);
    assert.equal(detail.pendingVersionSeq, null);
    await error(await call('POST', '/api/personas', body), 409, 'DUPLICATE_RESOURCE');
    for (const [column, value] of [
      ['name', '변경'],
      ['prompt_text', '변경'],
      ['voice_id', 'other'],
      ['turn_wait_level', 'SHORT'],
      ['speaking_rate', 1],
    ])
      await assert.rejects(
        pool.query(`UPDATE ai_persona_versions SET ${column}=$1 WHERE ai_persona_version_seq=$2`, [
          value,
          v.aiPersonaVersionSeq,
        ]),
        (e) => e.code === '23514',
      );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE action='PERSONA_CREATED' AND target_seq=$1 AND result='SUCCESS'",
          [v.aiPersonaVersionSeq],
        )
      ).rows[0].n,
      1,
    );
  });

  test('draft commits append whole snapshots, preserve omitted values, and reject stale or empty edits', async () => {
    const v1 = await create();
    const v2 = await data(
      await saveVersion(v1.aiPersonaSeq, { expectedVersion: 1, promptText: '새로운 원문' }),
    );
    assert.equal(v2.version, 2);
    assert.equal(v2.status, 'INACTIVE');
    for (const key of ['name', 'voiceId', 'speakingRate', 'turnWaitLevel'])
      assert.equal(v2[key], v1[key]);
    await error(
      await saveVersion(v1.aiPersonaSeq, { expectedVersion: 1, name: '오래된 수정' }),
      409,
      'VERSION_CONFLICT',
    );
    await error(await saveVersion(v1.aiPersonaSeq, { expectedVersion: 2 }), 400, 'INVALID_REQUEST');
    await error(
      await saveVersion(v1.aiPersonaSeq, { expectedVersion: 2, name: null }),
      400,
      'INVALID_REQUEST',
    );
    const same = await data(
      await saveVersion(v1.aiPersonaSeq, { expectedVersion: 2, name: v2.name }),
    );
    assert.equal(same.version, 2);
    const v3 = await data(
      await saveVersion(v1.aiPersonaSeq, { expectedVersion: 2, voiceId: null, speakingRate: null }),
    );
    assert.equal(v3.voiceId, null);
    assert.equal(v3.speakingRate, null);
    const historyResponse = await call('GET', `/api/personas/${v1.aiPersonaSeq}/versions?limit=2`);
    assert.equal(historyResponse.status, 200);
    const historyPage = await historyResponse.json();
    assert.equal(historyPage.total_count, 3);
    assert.equal(historyPage.hasNext, true);
    const history = historyPage.data;
    const pastEnd = await call('GET', `/api/personas/${v1.aiPersonaSeq}/versions?offset=100`);
    assert.deepEqual(await pastEnd.json(), { data: [], hasNext: false, total_count: 3 });
    assert.deepEqual(
      history.map((v) => v.version),
      [3, 2],
    );
    assert.equal(
      (
        await pool.query(
          'SELECT prompt_text FROM ai_persona_versions WHERE ai_persona_version_seq=$1',
          [v1.aiPersonaVersionSeq],
        )
      ).rows[0].prompt_text,
      v1.promptText,
    );
  });

  test('concurrent editors get one new version and a conflict without losing either saved snapshot', async () => {
    const v = await create();
    const results = await Promise.all(
      ['A', 'B'].map((name) => saveVersion(v.aiPersonaSeq, { expectedVersion: 1, name })),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM ai_persona_versions WHERE ai_persona_seq=$1',
          [v.aiPersonaSeq],
        )
      ).rows[0].n,
      2,
    );
  });

  test('actual capabilities validate settings and unavailable AI cannot silently accept invented options', async () => {
    assert.deepEqual(await data(await call('GET', '/api/ai/options')), options);
    for (const change of [{ voiceId: 'unknown' }, { speakingRate: 2 }, { turnWaitLevel: 'OTHER' }])
      await error(
        await call('POST', '/api/personas', input(change)),
        change.turnWaitLevel ? 400 : 422,
        change.turnWaitLevel ? 'INVALID_REQUEST' : 'BUSINESS_RULE_VIOLATION',
      );
    suite.aiResponse = {
      ...options,
      speakingRate: { min: null, max: null },
      turnWaitLevels: ['NORMAL'],
    };
    await error(await call('POST', '/api/personas', input()), 422, 'BUSINESS_RULE_VIOLATION');
    suite.aiResponse = { invalid: true };
    await error(await call('GET', '/api/ai/options'), 503, 'DEPENDENCY_UNAVAILABLE');
    suite.aiResponse = options;
    suite.aiStatus = 503;
    await error(await call('POST', '/api/personas', input()), 503, 'DEPENDENCY_UNAVAILABLE');
    suite.aiStatus = 200;
  });

  test('audit failure rolls back persona and version creation together', async () => {
    const { AuditService } = require('../dist/audit/audit.service');
    const audit = suite.app.get(AuditService),
      original = audit.recordSuccess;
    const body = input();
    audit.recordSuccess = async () => {
      throw new Error('test-only audit failure');
    };
    try {
      await error(await call('POST', '/api/personas', body), 500, 'INTERNAL_ERROR');
    } finally {
      audit.recordSuccess = original;
    }
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM ai_personas WHERE code=$1', [body.code]))
        .rows[0].n,
      0,
    );
  });
};
