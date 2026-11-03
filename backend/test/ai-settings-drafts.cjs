module.exports = function registerAiSettingsDrafts(suite) {
  const {
    test,
    create,
    data,
    report,
    activate,
    beginDraft,
    saveDraft,
    draftInput,
    assert,
    pool,
    versionCount,
    detail,
    runtime,
    commitDraft,
    actorIds,
    call,
    error,
    randomUUID,
    options,
    token,
    NestFactory,
    apps,
    logs,
    cookies,
  } = suite;
  test('draft saves overwrite one row without changing HEAD, history, ACTIVE or PENDING; commit consumes it atomically', async () => {
    const head = await create();
    await data(await report(await data(await activate(head), 202)));
    const pending = await data(await activate(await create()), 202);
    let draft = await beginDraft(head, { promptText: '초안 원문\n보존' });
    const createdAt = draft.createdAt;
    for (let i = 0; i < 5; i++) {
      const previous = draft;
      draft = await data(
        await saveDraft(head.aiPersonaSeq, draftInput(draft, { name: '중간 수정 ' + i })),
      );
      assert.notEqual(draft.draftRevision, previous.draftRevision);
      assert.equal(draft.createdAt, createdAt);
    }
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM ai_persona_drafts WHERE ai_persona_seq=$1',
          [head.aiPersonaSeq],
        )
      ).rows[0].n,
      1,
    );
    assert.equal(await versionCount(head.aiPersonaSeq), 1);
    const editing = await detail(head.aiPersonaSeq);
    assert.equal(editing.headVersion.aiPersonaVersionSeq, head.aiPersonaVersionSeq);
    assert.deepEqual(editing.draft, draft);
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, head.aiPersonaVersionSeq);
    assert.equal((await data(await runtime('PENDING'))).applicationId, pending.applicationId);
    assert.equal('version' in draft, false);
    assert.equal('status' in draft, false);
    assert.equal('draft' in (await data(await runtime())), false);
    const committed = await data(await commitDraft(head.aiPersonaSeq, draftInput(draft)));
    assert.equal(committed.version, 2);
    assert.equal(committed.promptText, draft.promptText);
    assert.equal(committed.name, draft.name);
    assert.equal(committed.status, 'INACTIVE');
    assert.equal((await detail(head.aiPersonaSeq)).draft, null);
    assert.equal(
      (await detail(head.aiPersonaSeq)).headVersion.aiPersonaVersionSeq,
      committed.aiPersonaVersionSeq,
    );
    assert.equal(await versionCount(head.aiPersonaSeq), 2);
    assert.equal((await data(await runtime())).aiPersonaVersionSeq, head.aiPersonaVersionSeq);
    assert.equal((await data(await runtime('PENDING'))).applicationId, pending.applicationId);
  });

  test('drafts are independent per type; partial edits merge the draft and unchanged saves do not rotate its revision', async () => {
    const a = await create(),
      b = await create();
    const first = await beginDraft(a, { name: 'A 초안', voiceId: null });
    const other = await beginDraft(b, { name: 'B 초안' }, 2);
    const next = await data(
      await saveDraft(
        a.aiPersonaSeq,
        draftInput(first, { promptText: '계속 작업', speakingRate: null }),
        2,
      ),
    );
    assert.equal(next.name, first.name);
    assert.equal(next.voiceId, null);
    assert.equal(next.speakingRate, null);
    assert.equal(next.turnWaitLevel, a.turnWaitLevel);
    assert.equal(next.updatedByAdminUserSeq, actorIds[2]);
    assert.deepEqual(
      await data(await saveDraft(a.aiPersonaSeq, draftInput(next, { name: next.name }))),
      next,
    );
    assert.deepEqual((await detail(b.aiPersonaSeq)).draft, other);
    const listed = await data(await call('GET', '/api/personas?limit=100'));
    assert.deepEqual(listed.find((row) => row.aiPersonaSeq === a.aiPersonaSeq).draft, next);
    const history = await (await call('GET', `/api/personas/${a.aiPersonaSeq}/versions`)).json();
    assert.equal(history.total_count, 1);
    assert.equal(history.data[0].name, a.name);
  });

  test('draft creation and overwrites each reject one simultaneous editor without lost updates', async () => {
    const head = await create();
    const created = await Promise.all(
      ['A', 'B'].map((name) =>
        saveDraft(head.aiPersonaSeq, {
          expectedVersion: 1,
          expectedDraftRevision: null,
          name,
        }),
      ),
    );
    assert.deepEqual(created.map((response) => response.status).sort(), [200, 409]);
    const first = (await detail(head.aiPersonaSeq)).draft;
    const updated = await Promise.all(
      ['C', 'D'].map((name) => saveDraft(head.aiPersonaSeq, draftInput(first, { name }))),
    );
    assert.deepEqual(updated.map((response) => response.status).sort(), [200, 409]);
    const saved = await data(updated.find((response) => response.status === 200));
    assert.deepEqual((await detail(head.aiPersonaSeq)).draft, saved);
    assert.equal(await versionCount(head.aiPersonaSeq), 1);
  });

  test('concurrent draft commits create one HEAD and consume the draft exactly once', async () => {
    const head = await create();
    const draft = await beginDraft(head);
    const results = await Promise.all([
      commitDraft(head.aiPersonaSeq, draftInput(draft)),
      commitDraft(head.aiPersonaSeq, draftInput(draft)),
    ]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);
    const committed = await data(results.find((response) => response.status === 200));
    assert.equal(committed.version, 2);
    assert.equal(await versionCount(head.aiPersonaSeq), 2);
    assert.equal((await detail(head.aiPersonaSeq)).draft, null);
    await error(await commitDraft(head.aiPersonaSeq, draftInput(draft)), 409, 'VERSION_CONFLICT');
  });

  test('a competing draft save and commit serialize without confirming unseen edits or resurrecting consumed drafts', async () => {
    const head = await create();
    const draft = await beginDraft(head);
    const [saved, committed] = await Promise.all([
      saveDraft(head.aiPersonaSeq, draftInput(draft, { name: '경쟁 수정' })),
      commitDraft(head.aiPersonaSeq, draftInput(draft)),
    ]);
    assert.deepEqual([saved.status, committed.status].sort(), [200, 409]);
    const state = await detail(head.aiPersonaSeq);
    if (committed.status === 200) {
      assert.equal(state.headVersion.name, draft.name);
      assert.equal(state.headVersion.version, 2);
      assert.equal(state.draft, null);
    } else {
      assert.equal(state.headVersion.version, 1);
      assert.equal(state.draft.name, '경쟁 수정');
    }
  });

  test('consumed revisions cannot overwrite or commit a later draft even with the current HEAD version', async () => {
    const head = await create();
    const first = await beginDraft(head);
    const committed = await data(await commitDraft(head.aiPersonaSeq, draftInput(first)));
    const next = await beginDraft(committed);
    assert.notEqual(first.draftRevision, next.draftRevision);
    for (const response of [
      await saveDraft(head.aiPersonaSeq, {
        expectedVersion: 2,
        expectedDraftRevision: first.draftRevision,
        name: '과거 요청',
      }),
      await commitDraft(head.aiPersonaSeq, {
        expectedVersion: 2,
        expectedDraftRevision: first.draftRevision,
      }),
    ])
      await error(response, 409, 'VERSION_CONFLICT');
    assert.deepEqual((await detail(head.aiPersonaSeq)).draft, next);
  });

  test('draft save audit failures roll back both a new draft and edits to an existing draft', async () => {
    const empty = await create(),
      existing = await create();
    const draft = await beginDraft(existing);
    const { AuditService } = require('../dist/audit/audit.service');
    const audit = suite.app.get(AuditService),
      original = audit.recordSuccess;
    audit.recordSuccess = async function (event, ...args) {
      if (event.action === 'PERSONA_DRAFT_SAVED') throw Error('draft-save-audit-failure');
      return original.call(this, event, ...args);
    };
    try {
      await error(
        await saveDraft(empty.aiPersonaSeq, {
          expectedVersion: 1,
          expectedDraftRevision: null,
          name: '실패',
        }),
        500,
        'INTERNAL_ERROR',
      );
      await error(
        await saveDraft(existing.aiPersonaSeq, draftInput(draft, { name: '실패' })),
        500,
        'INTERNAL_ERROR',
      );
    } finally {
      audit.recordSuccess = original;
    }
    assert.equal((await detail(empty.aiPersonaSeq)).draft, null);
    assert.deepEqual((await detail(existing.aiPersonaSeq)).draft, draft);
    assert.equal(await versionCount(existing.aiPersonaSeq), 1);
  });

  test('an audit failure after draft deletion rolls back HEAD creation, deletion and the version audit together', async () => {
    const head = await create();
    const draft = await beginDraft(head);
    const { AuditService } = require('../dist/audit/audit.service');
    const audit = suite.app.get(AuditService),
      original = audit.recordSuccess;
    audit.recordSuccess = async function (event, ...args) {
      if (event.action === 'PERSONA_DRAFT_COMMITTED') throw Error('draft-commit-audit-failure');
      return original.call(this, event, ...args);
    };
    try {
      await error(await commitDraft(head.aiPersonaSeq, draftInput(draft)), 500, 'INTERNAL_ERROR');
    } finally {
      audit.recordSuccess = original;
    }
    assert.deepEqual((await detail(head.aiPersonaSeq)).draft, draft);
    assert.equal(await versionCount(head.aiPersonaSeq), 1);
    assert.equal(
      (await detail(head.aiPersonaSeq)).headVersion.aiPersonaVersionSeq,
      head.aiPersonaVersionSeq,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM audit_logs a JOIN ai_persona_versions v ON a.target_seq=v.ai_persona_version_seq WHERE v.ai_persona_seq=$1 AND a.action='PERSONA_UPDATED' AND a.result='SUCCESS'",
          [head.aiPersonaSeq],
        )
      ).rows[0].n,
      0,
    );
    assert.equal((await data(await commitDraft(head.aiPersonaSeq, draftInput(draft)))).version, 2);
  });

  test('an unchanged draft is consumed without adding a duplicate version or changing published settings', async () => {
    const head = await create();
    const draft = await beginDraft(head, { name: head.name });
    const committed = await data(await commitDraft(head.aiPersonaSeq, draftInput(draft)));
    assert.equal(committed.aiPersonaVersionSeq, head.aiPersonaVersionSeq);
    assert.equal(await versionCount(head.aiPersonaSeq), 1);
    assert.equal((await detail(head.aiPersonaSeq)).draft, null);
  });

  test('missing, stale, foreign and malformed draft identities cannot create versions or overwrite settings', async () => {
    const head = await create(),
      other = await create();
    await error(
      await saveDraft(head.aiPersonaSeq, { expectedVersion: 1, name: '옛 형식' }),
      400,
      'INVALID_REQUEST',
    );
    await error(
      await commitDraft(head.aiPersonaSeq, {
        expectedVersion: 1,
        expectedDraftRevision: randomUUID(),
      }),
      409,
      'INVALID_STATE',
    );
    const draft = await beginDraft(head),
      foreign = await beginDraft(other);
    for (const body of [
      draftInput(draft, { expectedDraftRevision: null, name: '덮어쓰기' }),
      draftInput(draft, { expectedDraftRevision: foreign.draftRevision, name: '다른 유형' }),
      draftInput(draft, { expectedVersion: 2, name: '틀린 HEAD' }),
    ])
      await error(await saveDraft(head.aiPersonaSeq, body), 409, 'VERSION_CONFLICT');
    for (const body of [
      draftInput(draft),
      draftInput(draft, { name: null }),
      draftInput(draft, { promptText: '  ' }),
      draftInput(draft, { expectedDraftRevision: 'bad', name: '잘못된 UUID' }),
      draftInput(draft, { code: '변경 불가', name: '임의 코드' }),
    ])
      await error(await saveDraft(head.aiPersonaSeq, body), 400, 'INVALID_REQUEST');
    await error(
      await commitDraft(head.aiPersonaSeq, { expectedVersion: 1, expectedDraftRevision: null }),
      400,
      'INVALID_REQUEST',
    );
    await error(
      await saveDraft(2147483647, {
        expectedVersion: 1,
        expectedDraftRevision: null,
        name: '없는 유형',
      }),
      404,
      'NOT_FOUND',
    );
    assert.deepEqual((await detail(head.aiPersonaSeq)).draft, draft);
    assert.equal(await versionCount(head.aiPersonaSeq), 1);
  });

  test('unavailable or changed AI capabilities leave the editable draft and HEAD intact', async () => {
    const head = await create();
    const draft = await beginDraft(head);
    try {
      suite.aiStatus = 503;
      await error(
        await commitDraft(head.aiPersonaSeq, draftInput(draft)),
        503,
        'DEPENDENCY_UNAVAILABLE',
      );
      suite.aiStatus = 200;
      suite.aiResponse = { ...options, voices: [] };
      await error(
        await commitDraft(head.aiPersonaSeq, draftInput(draft)),
        422,
        'BUSINESS_RULE_VIOLATION',
      );
    } finally {
      suite.aiStatus = 200;
      suite.aiResponse = options;
    }
    assert.deepEqual((await detail(head.aiPersonaSeq)).draft, draft);
    assert.equal(await versionCount(head.aiPersonaSeq), 1);
  });

  test('draft writes and commits preserve admin roles, live account status, Origin and AI-token boundaries', async () => {
    const head = await create();
    const draft = await beginDraft(head, {}, 2);
    for (const actor of [0, 1, 2])
      assert.deepEqual((await detail(head.aiPersonaSeq, actor)).draft, draft);
    for (const [method, path, body] of [
      ['PATCH', `/api/personas/${head.aiPersonaSeq}`, draftInput(draft, { name: '권한 검사' })],
      ['POST', `/api/personas/${head.aiPersonaSeq}/versions`, draftInput(draft)],
    ]) {
      await error(await call(method, path, body, 1), 403, 'FORBIDDEN');
      await error(
        await call(method, path, body, 0, { Origin: 'https://foreign.invalid' }),
        403,
        'FORBIDDEN',
      );
      await error(
        await call(method, path, body, 99, { Cookie: undefined, Authorization: `Bearer ${token}` }),
        401,
        'UNAUTHORIZED',
      );
      for (const status of ['PENDING', 'INACTIVE']) {
        await pool.query('UPDATE admin_users SET status=$2 WHERE admin_user_seq=$1', [
          actorIds[2],
          status,
        ]);
        try {
          await error(await call(method, path, body, 2), 401, 'UNAUTHORIZED');
        } finally {
          await pool.query("UPDATE admin_users SET status='ACTIVE' WHERE admin_user_seq=$1", [
            actorIds[2],
          ]);
        }
      }
    }
    assert.equal(
      (await data(await commitDraft(head.aiPersonaSeq, draftInput(draft), 2)))
        .createdByAdminUserSeq,
      actorIds[2],
    );
  });

  test('the draft primary key enforces one row per type and rejects invalid stored settings', async () => {
    const head = await create();
    await beginDraft(head);
    await assert.rejects(
      pool.query(
        `INSERT INTO ai_persona_drafts SELECT * FROM ai_persona_drafts WHERE ai_persona_seq=$1`,
        [head.aiPersonaSeq],
      ),
      { code: '23505' },
    );
    for (const sql of [
      "UPDATE ai_persona_drafts SET name='  ' WHERE ai_persona_seq=$1",
      'UPDATE ai_persona_drafts SET base_version=0 WHERE ai_persona_seq=$1',
      "UPDATE ai_persona_drafts SET turn_wait_level='UNKNOWN' WHERE ai_persona_seq=$1",
      "UPDATE ai_persona_drafts SET speaking_rate='Infinity' WHERE ai_persona_seq=$1",
    ])
      await assert.rejects(pool.query(sql, [head.aiPersonaSeq]), { code: '23514' });
  });

  test('Swagger distinguishes mutable drafts from final versions and does not offer direct HEAD edits', async () => {
    const spec = await (await fetch(suite.base + '/api/docs-json')).json();
    const update = spec.components.schemas.UpdatePersonaDto;
    assert.ok(update.required.includes('expectedDraftRevision'));
    assert.ok(update.properties.expectedDraftRevision.nullable);
    assert.ok(
      spec.components.schemas.CommitPersonaDraftDto.required.includes('expectedDraftRevision'),
    );
    assert.ok(spec.components.schemas.PersonaDto.properties.draft.nullable);
    assert.equal('version' in spec.components.schemas.PersonaDraftDto.properties, false);
    assert.equal(
      spec.paths['/api/personas/{id}'].patch.responses['200'].content['application/json'].schema
        .$ref,
      '#/components/schemas/PersonaDraftResponseDto',
    );
    assert.equal(
      spec.paths['/api/personas/{id}/versions'].post.responses['200'].content['application/json']
        .schema.$ref,
      '#/components/schemas/PersonaVersionResponseDto',
    );
    assert.equal(spec.paths['/api/personas/{id}/head'], undefined);
  });

  test(
    'another backend resumes the draft and rechecks both identities after external validation without holding a DB lock',
    { timeout: 15000 },
    async () => {
      const { AppModule } = require('../dist/app.module');
      const { configureApplication } = require('../dist/configure-application');
      const { AiPersonaClient } = require('../dist/ai-settings/ai-persona.client');
      const second = await NestFactory.create(AppModule, { logger: false });
      apps.push(second);
      configureApplication(second, { log: (entry) => logs.push(entry) });
      await second.listen(0, '127.0.0.1');
      const secondBase = await second.getUrl();
      const send = (method, path, body) =>
        fetch(secondBase + path, {
          method,
          headers: {
            Cookie: cookies[0],
            Origin: process.env.CORS_ORIGINS,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const client = second.get(AiPersonaClient),
        original = client.options;
      for (const operation of ['save', 'commit']) {
        const head = await create();
        const draft = await beginDraft(head);
        assert.deepEqual(
          (await data(await send('GET', `/api/personas/${head.aiPersonaSeq}`))).draft,
          draft,
        );
        let entered, release;
        const selected = new Promise((resolve) => {
          entered = resolve;
        });
        const resume = new Promise((resolve) => {
          release = resolve;
        });
        client.options = async function () {
          entered();
          await resume;
          return original.call(this);
        };
        const waiting =
          operation === 'save'
            ? send(
                'PATCH',
                `/api/personas/${head.aiPersonaSeq}`,
                draftInput(draft, { name: '대기 중 수정' }),
              )
            : send('POST', `/api/personas/${head.aiPersonaSeq}/versions`, draftInput(draft));
        try {
          await Promise.race([
            selected,
            waiting.then(() => {
              throw Error('request skipped external validation');
            }),
          ]);
          if (operation === 'save') {
            await data(await commitDraft(head.aiPersonaSeq, draftInput(draft)));
          } else {
            await data(
              await saveDraft(head.aiPersonaSeq, draftInput(draft, { name: '다른 서버 수정' })),
            );
          }
          release();
          await error(await waiting, 409, 'VERSION_CONFLICT');
          const state = await detail(head.aiPersonaSeq);
          assert.equal(state.headVersion.version, operation === 'save' ? 2 : 1);
          if (operation === 'save') assert.equal(state.draft, null);
          else assert.equal(state.draft.name, '다른 서버 수정');
        } finally {
          release();
          client.options = original;
          await waiting;
        }
      }
    },
  );

  test('version limit errors preserve the sole draft and existing HEAD', async () => {
    const first = await create();
    await pool.query(
      `INSERT INTO ai_persona_versions(ai_persona_seq,version,name,prompt_text,turn_wait_level)
    VALUES($1,2147483647,'상한 HEAD','기존 내용','NORMAL')`,
      [first.aiPersonaSeq],
    );
    const head = (await detail(first.aiPersonaSeq)).headVersion;
    const draft = await beginDraft(head);
    await error(await commitDraft(first.aiPersonaSeq, draftInput(draft)), 409, 'INVALID_STATE');
    assert.deepEqual((await detail(first.aiPersonaSeq)).draft, draft);
    assert.equal((await detail(first.aiPersonaSeq)).headVersion.version, 2147483647);
    assert.equal(await versionCount(first.aiPersonaSeq), 2);
  });

  require('./ai-settings-migrations.cjs').draftStore(suite);

  require('./ai-settings-migrations.cjs').latestHeads(suite);
};
