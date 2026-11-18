require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
const {
  readCapabilities,
  validatePersonaOptions,
} = require('../dist/ai-settings/ai-persona.client');
const {
  CreatePersonaDto,
  UpdatePersonaDto,
  CommitPersonaDraftDto,
} = require('../dist/ai-settings/dto/persona-request.dto');
const { PersonaApplyResultDto } = require('../dist/ai-settings/dto/persona-application.dto');
const { validateEnvironment } = require('../dist/config/environment');
const {
  composePersonaPrompt,
  PERSONA_PROMPT_FIELDS,
} = require('../dist/ai-settings/persona-prompt');
const promptFields = {
  role: ' 안내 원문\n',
  personality: '밝게',
  tone: '존댓말',
  speedInstruction: '빠르게',
  backchannel: '가끔',
  interruption: '즉시 멈춤',
};
const options = {
  voices: [{ id: 'test-voice', label: '테스트 음성' }],
  speakingRate: { min: 0.8, max: 1.2 },
  turnWaitLevels: ['NORMAL', 'LONG'],
};
const settings = {
  name: '상담원',
  promptText: ' 안내 원문\n',
  voiceId: null,
  speakingRate: null,
  turnWaitLevel: 'NORMAL',
};
test('capabilities preserve explicit unsupported controls and reject malformed upstream data', () => {
  assert.deepEqual(readCapabilities(options), options);
  assert.deepEqual(
    readCapabilities({ ...options, speakingRate: { min: null, max: null } }).speakingRate,
    { min: null, max: null },
  );
  for (const value of [
    null,
    {},
    { ...options, voices: [{ id: '', label: 'bad' }] },
    { ...options, voices: [...options.voices, ...options.voices] },
    { ...options, speakingRate: { min: 2, max: 1 } },
    { ...options, speakingRate: { min: null, max: 2 } },
    { ...options, turnWaitLevels: [] },
    { ...options, turnWaitLevels: ['UNKNOWN'] },
  ])
    assert.throws(() => readCapabilities(value));
});
test('settings use actual capability ranges and reject unsupported voices, speed and wait controls', () => {
  validatePersonaOptions(settings, options);
  validatePersonaOptions(
    { ...settings, voiceId: 'test-voice', speakingRate: 0.8, turnWaitLevel: 'LONG' },
    options,
  );
  for (const input of [{ voiceId: 'invented' }, { speakingRate: 2 }, { turnWaitLevel: 'SHORT' }])
    assert.throws(
      () => validatePersonaOptions({ ...settings, ...input }, options),
      (error) => error.getStatus() === 422,
    );
  assert.throws(() =>
    validatePersonaOptions(
      { ...settings, speakingRate: 1 },
      { ...options, speakingRate: { min: null, max: null } },
    ),
  );
});
test('six prompt fields preserve input and create defaults do not leak into PATCH', () => {
  const created = plainToInstance(CreatePersonaDto, {
    code: 'parcel',
    name: settings.name,
    ...promptFields,
  });
  assert.equal(validateSync(created).length, 0);
  for (const key of PERSONA_PROMPT_FIELDS) assert.equal(created[key], promptFields[key]);
  assert.equal(created.voiceId, null);
  assert.equal(created.turnWaitLevel, 'NORMAL');
  const patch = plainToInstance(UpdatePersonaDto, {
    expectedVersion: 1,
    expectedDraftRevision: null,
    tone: '새 본문',
  });
  assert.equal(validateSync(patch).length, 0);
  for (const field of ['voiceId', 'speakingRate', 'turnWaitLevel', 'name'])
    assert.equal(patch[field], undefined);
  for (const input of [
    { name: null },
    ...PERSONA_PROMPT_FIELDS.flatMap((key) => [{ [key]: ' \n\t' }, { [key]: null }]),
    { turnWaitLevel: null },
    { speakingRate: 0 },
    { expectedVersion: '1' },
  ])
    assert.ok(
      validateSync(
        plainToInstance(UpdatePersonaDto, {
          expectedVersion: 1,
          expectedDraftRevision: null,
          ...input,
        }),
      ).length > 0,
    );
});

test('prompt composition fixes heading order, preserves multiline text and matches the AI Unicode limit', () => {
  const expected =
    '# 페르소나\n\n## 역할\n 안내 원문\n\n\n## 성격\n밝게\n\n## 발화 스타일\n### 톤\n존댓말\n\n### 속도\n빠르게\n\n## 맞장구\n가끔\n\n## 끼어들기\n즉시 멈춤';
  assert.equal(composePersonaPrompt(promptFields), expected);
  const padding = '😀'.repeat(20000 - Array.from(expected).length);
  const boundary = { ...promptFields, role: promptFields.role + padding };
  assert.equal(Array.from(composePersonaPrompt(boundary)).length, 20000);
  assert.throws(
    () => composePersonaPrompt({ ...boundary, role: boundary.role + '😀' }),
    (error) => error.getStatus() === 422,
  );
});

test('draft writes require an explicit nullable revision and commits require an existing UUID revision', () => {
  const revision = '00000000-0000-4000-8000-000000000039';
  for (const expectedDraftRevision of [null, revision])
    assert.equal(
      validateSync(
        plainToInstance(UpdatePersonaDto, {
          expectedVersion: 4,
          expectedDraftRevision,
          name: '작성 중',
        }),
      ).length,
      0,
    );
  for (const expectedDraftRevision of [undefined, '', 1, 'bad', [], {}])
    assert.ok(
      validateSync(
        plainToInstance(UpdatePersonaDto, {
          expectedVersion: 4,
          expectedDraftRevision,
          name: '작성 중',
        }),
      ).length > 0,
    );
  assert.equal(
    validateSync(
      plainToInstance(CommitPersonaDraftDto, {
        expectedVersion: 4,
        expectedDraftRevision: revision,
      }),
    ).length,
    0,
  );
  for (const expectedDraftRevision of [undefined, null, 'bad', 1])
    assert.ok(
      validateSync(
        plainToInstance(CommitPersonaDraftDto, {
          expectedVersion: 4,
          expectedDraftRevision,
        }),
      ).length > 0,
    );
});
test('apply results accept an omitted legacy call count and still validate supplied counts', () => {
  const result = {
    aiPersonaVersionSeq: 1,
    applicationId: '00000000-0000-4000-8000-000000000001',
    result: 'APPLIED',
  };
  for (const activeCallCount of [undefined, 0, 2, 2147483647])
    assert.deepEqual(
      validateSync(plainToInstance(PersonaApplyResultDto, { ...result, activeCallCount })),
      [],
    );
  for (const activeCallCount of [null, '0', -1, 0.5, 2147483648])
    assert.ok(
      validateSync(plainToInstance(PersonaApplyResultDto, { ...result, activeCallCount })).some(
        (error) => error.property === 'activeCallCount',
      ),
    );
});
test('persona service token is optional for existing services and is never echoed on validation failure', () => {
  const env = {
    NODE_ENV: 'test',
    DB_HOST: '127.0.0.1',
    DB_USER: 'test',
    DB_PASSWORD: 'test',
    DB_NAME: 'test',
    AI_AGENT_URL: 'http://ai:8000',
  };
  assert.equal(validateEnvironment(env).AI_PERSONA_TOKEN, undefined);
  assert.equal(
    validateEnvironment({ ...env, AI_PERSONA_TOKEN: 'a'.repeat(32) }).AI_PERSONA_TOKEN,
    'a'.repeat(32),
  );
  for (const secret of ['short-secret', 'a'.repeat(32) + ' ', '가'.repeat(32)])
    assert.throws(
      () => validateEnvironment({ ...env, AI_PERSONA_TOKEN: secret }),
      (error) => error.message.includes('AI_PERSONA_TOKEN') && !error.message.includes(secret),
    );
});

test('shared option reads isolate callers, expire on settlement and separate rotated credentials', async () => {
  const { AiPersonaClient } = require('../dist/ai-settings/ai-persona.client');
  const config = { url: 'http://synthetic.invalid', token: 'synthetic' };
  const client = new AiPersonaClient({
    get: (key) => (key === 'AI_AGENT_URL' ? config.url : config.token),
  });
  const value = {
    voices: [{ id: 'one', label: 'Voice' }],
    speakingRate: { min: null, max: null },
    turnWaitLevels: ['NORMAL'],
  };
  let calls = 0,
    release,
    fail = false;
  client.options = async () => {
    calls++;
    await new Promise((resolve) => {
      release = resolve;
    });
    if (fail) throw Error('synthetic');
    return structuredClone(value);
  };
  const first = client.sharedOptions(),
    second = client.sharedOptions();
  assert.equal(calls, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  a.voices[0].label = 'changed';
  assert.deepEqual(b, value);
  const fresh = client.sharedOptions();
  assert.equal(calls, 2);
  release();
  await fresh;
  fail = true;
  const rejected = client.sharedOptions();
  release();
  await assert.rejects(rejected);
  fail = false;
  const recovered = client.sharedOptions();
  assert.equal(calls, 4);
  release();
  await recovered;
  const pending = client.sharedOptions();
  const oldRelease = release;
  config.token = 'rotated';
  const rotated = client.sharedOptions();
  const newRelease = release;
  oldRelease();
  await pending;
  const joined = client.sharedOptions();
  assert.equal(calls, 6);
  newRelease();
  await Promise.all([rotated, joined]);
});

test('health shares only the upstream probe and checks each caller database independently', async (t) => {
  const { HealthService } = require('../dist/health/health.service');
  let fetches = 0,
    queries = 0,
    databaseOk = true,
    release;
  t.mock.method(globalThis, 'fetch', () => {
    fetches++;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const health = new HealthService(
    {
      pool: {
        query: async () => {
          queries++;
          if (!databaseOk) throw Error('synthetic');
          return {};
        },
      },
    },
    { get: () => 'http://synthetic.invalid' },
  );
  const concurrent = Array.from({ length: 20 }, () => health.checkDependencies());
  assert.equal(fetches, 1);
  assert.equal(queries, 20);
  release({ ok: true });
  assert.ok((await Promise.all(concurrent)).every((value) => value.status === 'ok'));
  databaseOk = false;
  const databaseFailure = health.checkDependencies();
  release({ ok: true });
  await assert.rejects(databaseFailure, (error) => error.getStatus() === 503);
  databaseOk = true;
  const upstreamFailure = health.checkDependencies();
  release({ ok: false });
  await assert.rejects(upstreamFailure, (error) => error.getStatus() === 503);
  const recovered = health.checkDependencies();
  release({ ok: true });
  assert.equal((await recovered).status, 'ok');
  assert.equal(fetches, 4);
  assert.equal(queries, 23);
});
