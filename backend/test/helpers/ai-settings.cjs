const { createTestPool, startTestApp } = require('./application.cjs');

module.exports = function aiSettingsFixture() {
  require('reflect-metadata');
  const { before, after, test } = require('node:test');
  const assert = require('node:assert/strict');
  const { randomUUID, randomBytes, createHash } = require('node:crypto');
  const { migrate } = require('./migrations.cjs');
  const { createServer } = require('node:http');
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(process.env.DB_NAME, 'dva_webhook_test');
  assert.ok(['db', '127.0.0.1'].includes(process.env.DB_HOST));
  process.env.CORS_ORIGINS = 'http://localhost:5173';
  process.env.SWAGGER_ENABLED = 'false';
  const token = randomBytes(32).toString('hex');
  process.env.AI_PERSONA_TOKEN = token;
  const pool = createTestPool();
  const options = {
    voices: [{ id: 'test-voice', label: '테스트 음성' }],
    speakingRate: { min: 0.8, max: 1.2 },
    turnWaitLevels: ['SHORT', 'NORMAL', 'LONG'],
  };
  const cookies = [],
    actorIds = [],
    apps = [],
    notifications = [],
    logs = [];
  let app,
    base,
    ai,
    aiResponse = options,
    aiStatus = 200,
    refreshStatus = 202;
  const call = (method, path, body, actor = 0, headers = {}) =>
    fetch(base + path, {
      method,
      headers: Object.fromEntries(
        Object.entries({
          Origin: process.env.CORS_ORIGINS,
          Cookie: cookies[actor],
          'Content-Type': 'application/json',
          ...headers,
        }).filter(([, v]) => v !== undefined),
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function data(response, status = 200) {
    assert.equal(response.status, status, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return (await response.json()).data;
  }
  async function error(response, status, code) {
    assert.equal(response.status, status, await response.clone().text());
    const result = await response.json();
    assert.equal(result.error.code, code);
    assert.ok(result.meta.requestId);
  }
  const input = (changes = {}) => ({
    code: 'test-' + randomUUID(),
    name: '테스트 상담원',
    role: ' 원문\n보존 ',
    personality: '밝은 성격',
    tone: '존댓말',
    speedInstruction: '간결하게',
    backchannel: '작게 맞장구',
    interruption: '즉시 멈춤',
    voiceId: 'test-voice',
    speakingRate: 1.2,
    turnWaitLevel: 'LONG',
    ...changes,
  });
  const create = async (changes = {}) =>
    data(await call('POST', '/api/personas', input(changes)), 201);
  const detail = async (id, actor = 0) =>
    data(await call('GET', `/api/personas/${id}`, undefined, actor));
  const saveDraft = (id, body, actor = 0) => call('PATCH', `/api/personas/${id}`, body, actor);
  const commitDraft = (id, body, actor = 0) =>
    call('POST', `/api/personas/${id}/versions`, body, actor);
  async function saveVersion(id, body, actor = 0) {
    const current = await data(await call('GET', `/api/personas/${id}`, undefined, actor));
    const response = await saveDraft(
      id,
      {
        ...body,
        expectedDraftRevision: current.draft?.draftRevision ?? null,
      },
      actor,
    );
    if (response.status !== 200) return response;
    const draft = await data(response);
    return commitDraft(
      id,
      {
        expectedVersion: body.expectedVersion,
        expectedDraftRevision: draft.draftRevision,
      },
      actor,
    );
  }
  before(async () => {
    await migrate(pool);
    ai = createServer(async (request, response) => {
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      if (request.url === '/internal/persona/options') {
        response.writeHead(aiStatus, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(aiResponse));
      } else if (request.url === '/internal/persona/refresh') {
        let body = '';
        for await (const part of request) body += part;
        notifications.push(JSON.parse(body));
        response.writeHead(refreshStatus);
        response.end();
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolve) => ai.listen(0, '127.0.0.1', resolve));
    process.env.AI_AGENT_URL = `http://127.0.0.1:${ai.address().port}`;
    app = await startTestApp(apps, { log: (entry) => logs.push(entry) });
    base = await app.getUrl();
    for (const role of ['SYSTEM_ADMIN', 'OPERATOR', 'SUPERVISOR']) {
      const id = (
        await pool.query(
          "INSERT INTO admin_users(login_id,name,password_hash,role,status) VALUES($1,'설정 테스트 관리자','not-for-login',$2,'ACTIVE') RETURNING admin_user_seq",
          ['p' + randomUUID().replaceAll('-', '').slice(0, 18), role],
        )
      ).rows[0].admin_user_seq;
      actorIds.push(id);
      const session = randomBytes(32).toString('hex');
      await pool.query(
        'INSERT INTO admin_sessions(session_token_hash,admin_user_seq) VALUES($1,$2)',
        [createHash('sha256').update(session).digest('hex'), id],
      );
      cookies.push('dva_session=' + session);
    }
  });
  after(async () => {
    for (const application of apps) await application.close();
    if (ai) await new Promise((resolve) => ai.close(resolve));
    await pool.end();
  });

  const serviceCall = (method, path, body, headers = {}) =>
    call(method, path, body, 99, {
      Cookie: undefined,
      Origin: undefined,
      Authorization: `Bearer ${token}`,
      ...headers,
    });
  const activate = (version, expectedVersion = version.version) =>
    call('POST', `/api/personas/${version.aiPersonaSeq}/activate`, {
      aiPersonaVersionSeq: version.aiPersonaVersionSeq,
      expectedVersion,
    });
  const report = (version, changes = {}) =>
    serviceCall('POST', '/api/ai/config/apply-result', {
      aiPersonaVersionSeq: version.aiPersonaVersionSeq,
      applicationId: version.applicationId,
      result: 'APPLIED',
      activeCallCount: 0,
      ...changes,
    });
  const runtime = (status = 'ACTIVE') => serviceCall('GET', '/api/ai/config?status=' + status);
  const applicationService = () =>
    app.get(
      require('../../dist/ai-settings/persona-application.service').PersonaApplicationService,
    );

  async function legacyVersion(actorId, recordAudit = true) {
    const { AiSettingsRepository } = require('../../dist/ai-settings/ai-settings.repository');
    const { AuditService } = require('../../dist/audit/audit.service');
    const { DatabaseService } = require('../../dist/database/database.service');
    return app.get(DatabaseService).transaction(async (client) => {
      const repository = app.get(AiSettingsRepository);
      const id = await repository.create('legacy-' + randomUUID(), client);
      const settings = input();
      const { composePersonaPrompt } = require('../../dist/ai-settings/persona-prompt');
      const version = await repository.append(
        id,
        1,
        { ...settings, promptText: composePersonaPrompt(settings) },
        actorId,
        client,
      );
      if (recordAudit)
        await app.get(AuditService).recordSuccess(
          {
            actorId,
            targetId: version.aiPersonaVersionSeq,
            targetType: 'AI_PERSONA_VERSION',
            action: 'PERSONA_CREATED',
            requestId: randomUUID(),
          },
          client,
        );
      return version;
    });
  }

  const beginDraft = async (version, changes = {}, actor = 0) =>
    data(
      await saveDraft(
        version.aiPersonaSeq,
        {
          expectedVersion: version.version,
          expectedDraftRevision: null,
          name: '작성 중 초안',
          ...changes,
        },
        actor,
      ),
    );
  const draftInput = (draft, changes = {}) => ({
    expectedVersion: draft.baseVersion,
    expectedDraftRevision: draft.draftRevision,
    ...changes,
  });
  const versionCount = async (id) =>
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM ai_persona_versions WHERE ai_persona_seq=$1',
        [id],
      )
    ).rows[0].n;
  return {
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
    get aiResponse() {
      return aiResponse;
    },
    set aiResponse(value) {
      aiResponse = value;
    },
    get aiStatus() {
      return aiStatus;
    },
    set aiStatus(value) {
      aiStatus = value;
    },
    get app() {
      return app;
    },
    set app(value) {
      app = value;
    },
    serviceCall,
    runtime,
    activate,
    applicationService,
    notifications,
    report,
    randomUUID,
    get refreshStatus() {
      return refreshStatus;
    },
    set refreshStatus(value) {
      refreshStatus = value;
    },
    apps,
    logs,
    get base() {
      return base;
    },
    set base(value) {
      base = value;
    },
    legacyVersion,
    beginDraft,
    saveDraft,
    draftInput,
    versionCount,
    detail,
    commitDraft,
    cookies,
  };
};
