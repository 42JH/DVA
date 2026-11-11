module.exports = function personaDeletion(suite) {
  const {
    test,
    assert,
    call,
    create,
    data,
    error,
    pool,
    beginDraft,
    saveVersion,
    activate,
    report,
    runtime,
    randomUUID,
  } = suite;
  const remove = (ids, actor = 0, headers = {}) =>
    call('DELETE', '/api/personas', { aiPersonaSeqs: ids }, actor, headers);
  const state = async (ids) =>
    (
      await pool.query(
        `SELECT p.ai_persona_seq AS id,p.deleted_at,
    (SELECT count(*)::int FROM ai_persona_versions v WHERE v.ai_persona_seq=p.ai_persona_seq AND v.deleted_at IS NULL) AS versions,
    (SELECT count(*)::int FROM ai_persona_drafts d WHERE d.ai_persona_seq=p.ai_persona_seq AND d.deleted_at IS NULL) AS drafts
    FROM ai_personas p WHERE p.ai_persona_seq=ANY($1::int[]) ORDER BY p.ai_persona_seq`,
        [ids],
      )
    ).rows;

  test('persona deletion keeps existing write roles, session and Origin checks with a strict array body', async () => {
    const p = await create();
    await error(await remove([], 1), 400, 'INVALID_REQUEST');
    await error(await remove([p.aiPersonaSeq], 99, { Cookie: undefined }), 401, 'UNAUTHORIZED');
    await error(
      await remove([p.aiPersonaSeq], 0, { Origin: 'https://foreign.invalid' }),
      403,
      'FORBIDDEN',
    );
    const ai = await suite.serviceCall('DELETE', '/api/personas', {
      aiPersonaSeqs: [p.aiPersonaSeq],
    });
    assert.ok([401, 403].includes(ai.status));
    for (const ids of [
      [],
      [p.aiPersonaSeq, p.aiPersonaSeq],
      ['1'],
      [0],
      [-1],
      [1.5],
      Array.from({ length: 101 }, (_, i) => i + 1),
      null,
    ])
      await error(await remove(ids), 400, 'INVALID_REQUEST');
    await error(await call('DELETE', '/api/personas', {}), 400, 'INVALID_REQUEST');
    assert.equal((await remove([p.aiPersonaSeq], 1)).status, 204);
  });

  test('one array API soft deletes a type and every version/draft together while retaining immutable contents and list counts', async () => {
    const a = await create(),
      b = await create();
    const v2 = await data(
      await saveVersion(a.aiPersonaSeq, { expectedVersion: 1, name: '분류의 최신 버전' }),
    );
    await beginDraft(v2, { name: '작성 중 초안' });
    const before = (
      await pool.query(
        `SELECT to_jsonb(v)-'deleted_at'-'status' AS content FROM ai_persona_versions v
      WHERE ai_persona_seq=$1 ORDER BY version`,
        [a.aiPersonaSeq],
      )
    ).rows;
    const count = (await (await call('GET', '/api/personas?limit=1')).json()).total_count;
    const response = await remove([b.aiPersonaSeq, a.aiPersonaSeq]);
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    const rows = await state([a.aiPersonaSeq, b.aiPersonaSeq]);
    assert.ok(rows.every((r) => r.deleted_at && r.versions === 0 && r.drafts === 0));
    const timestamps = (
      await pool.query(
        `SELECT deleted_at FROM ai_personas WHERE ai_persona_seq=$1
      UNION ALL SELECT deleted_at FROM ai_persona_versions WHERE ai_persona_seq=$1
      UNION ALL SELECT deleted_at FROM ai_persona_drafts WHERE ai_persona_seq=$1`,
        [a.aiPersonaSeq],
      )
    ).rows;
    assert.equal(new Set(timestamps.map((r) => r.deleted_at.toISOString())).size, 1);
    assert.deepEqual(
      (
        await pool.query(
          `SELECT to_jsonb(v)-'deleted_at'-'status' AS content FROM ai_persona_versions v
      WHERE ai_persona_seq=$1 ORDER BY version`,
          [a.aiPersonaSeq],
        )
      ).rows,
      before,
    );
    assert.equal(
      (await (await call('GET', '/api/personas?limit=1')).json()).total_count,
      count - 2,
    );
    for (const path of [
      '/api/personas/' + a.aiPersonaSeq,
      '/api/personas/' + a.aiPersonaSeq + '/versions',
    ])
      await error(await call('GET', path), 404, 'NOT_FOUND');
    await error(await activate(v2), 404, 'NOT_FOUND');
    await error(
      await suite.saveDraft(a.aiPersonaSeq, {
        expectedVersion: 2,
        expectedDraftRevision: null,
        name: '복원 시도',
      }),
      404,
      'NOT_FOUND',
    );
    await error(await remove([a.aiPersonaSeq]), 404, 'NOT_FOUND');
    const audit = (
      await pool.query(
        `SELECT action,count(*)::int AS n FROM audit_logs WHERE request_id=$1 AND result='SUCCESS' GROUP BY action ORDER BY action`,
        [response.headers.get('x-request-id')],
      )
    ).rows;
    assert.deepEqual(audit, [
      { action: 'PERSONA_DELETED', n: 2 },
      { action: 'PERSONA_DRAFT_DELETED', n: 1 },
      { action: 'PERSONA_VERSION_DELETED', n: 3 },
    ]);
  });

  test('ACTIVE type is protected even when the representative AI version is older than HEAD and one batch item is inactive', async () => {
    const active = await create();
    await data(await report(await data(await activate(active), 202)));
    const head = await data(
      await saveVersion(active.aiPersonaSeq, {
        expectedVersion: 1,
        name: '아직 적용하지 않은 최신 버전',
      }),
    );
    await beginDraft(head, { name: '대표 분류 초안' });
    const other = await create();
    const ids = [active.aiPersonaSeq, other.aiPersonaSeq];
    const before = await state(ids);
    await error(await remove(ids.reverse()), 409, 'INVALID_STATE');
    assert.deepEqual(await state(ids), before);
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
    await assert.rejects(
      pool.query(
        'UPDATE ai_persona_versions SET deleted_at=clock_timestamp() WHERE ai_persona_version_seq=$1',
        [active.aiPersonaVersionSeq],
      ),
      (e) => e.code === '23514',
    );
    await error(await remove([other.aiPersonaSeq, 2147483647]), 404, 'NOT_FOUND');
    assert.equal((await state([other.aiPersonaSeq]))[0].deleted_at, null);
  });

  test('deleting pending types cancels notifications and stale AI apply callbacks without changing ACTIVE', async () => {
    const active = await data(await runtime());
    const p = await create(),
      pending = await data(await activate(p), 202);
    assert.equal((await remove([p.aiPersonaSeq])).status, 204);
    const before = suite.notifications.length;
    await suite.applicationService().tick();
    assert.equal(suite.notifications.length, before);
    await error(await runtime('PENDING'), 404, 'NOT_FOUND');
    await error(await report(pending), 409, 'VERSION_CONFLICT');
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, active.aiPersonaVersionSeq);
  });

  test('audit failure rolls back every type, version, draft and deletion audit in the batch', async () => {
    const a = await create(),
      b = await create();
    await beginDraft(a);
    const ids = [a.aiPersonaSeq, b.aiPersonaSeq],
      before = await state(ids);
    const { AuditService } = require('../dist/audit/audit.service');
    const audit = suite.app.get(AuditService),
      original = audit.recordSuccess;
    audit.recordSuccess = async function (event, client) {
      if (event.action === 'PERSONA_DELETED' && event.targetId === b.aiPersonaSeq)
        throw Error('test audit failure');
      return original.call(this, event, client);
    };
    let response;
    try {
      response = await remove(ids);
      await error(response, 500, 'INTERNAL_ERROR');
    } finally {
      audit.recordSuccess = original;
    }
    assert.deepEqual(await state(ids), before);
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs WHERE request_id=$1 AND result='SUCCESS'",
          [response.headers.get('x-request-id')],
        )
      ).rows[0].n,
      0,
    );
  });

  test('historical and late call analyses retain deleted persona version references', async () => {
    const p = await create();
    const provider = randomUUID(),
      startedAt = new Date(Date.now() - 60000).toISOString(),
      endedAt = new Date().toISOString();
    const id = (
      await pool.query(
        'INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at,started_at,ended_at) VALUES($1,$2,$3,$3,$4) RETURNING call_session_seq',
        [provider, '01087654321', startedAt, endedAt],
      )
    ).rows[0].call_session_seq;
    assert.equal((await remove([p.aiPersonaSeq])).status, 204);
    const { CallInsightsService } = require('../dist/call-insights/call-insights.service');
    await suite.app.get(CallInsightsService).save(
      id,
      {
        providerCallId: provider,
        startedAt,
        endedAt,
        aiPersonaVersionSeq: p.aiPersonaVersionSeq,
        repeatQuestionCount: 0,
        hasComplaint: false,
        complaints: [],
      },
      randomUUID(),
    );
    const detail = await data(await call('GET', '/api/calls/' + id));
    assert.equal(detail.analysis.aiPersonaVersionSeq, p.aiPersonaVersionSeq);
    assert.equal(detail.analysis.personaName, p.name);
    assert.equal(detail.analysis.personaVersion, 1);
  });

  test('deletion and AI activation serialize so a type is never both deleted and ACTIVE', async () => {
    const { AiSettingsRepository } = require('../dist/ai-settings/ai-settings.repository');
    const repo = suite.app.get(AiSettingsRepository);
    for (const first of ['removeMany', 'apply']) {
      const p = await create(),
        pending = await data(await activate(p), 202);
      let enter, release;
      const entered = new Promise((r) => {
          enter = r;
        }),
        gate = new Promise((r) => {
          release = r;
        });
      const original = repo[first];
      repo[first] = async function (...args) {
        enter();
        await gate;
        return original.apply(this, args);
      };
      let removal, applied;
      try {
        if (first === 'removeMany') {
          removal = remove([p.aiPersonaSeq]);
          await entered;
          applied = report(pending);
        } else {
          applied = report(pending);
          await entered;
          removal = remove([p.aiPersonaSeq]);
        }
        release();
        const [d, a] = await Promise.all([removal, applied]);
        assert.equal(d.status, first === 'removeMany' ? 204 : 409);
        assert.equal(a.status, first === 'apply' ? 200 : 409);
        const row = (
          await pool.query(
            'SELECT status,deleted_at FROM ai_persona_versions WHERE ai_persona_version_seq=$1',
            [p.aiPersonaVersionSeq],
          )
        ).rows[0];
        assert.equal(row.status, first === 'apply' ? 'ACTIVE' : 'INACTIVE');
        assert.equal(row.deleted_at !== null, first === 'removeMany');
      } finally {
        release();
        repo[first] = original;
        await Promise.allSettled([removal, applied].filter(Boolean));
      }
    }
  });
};
