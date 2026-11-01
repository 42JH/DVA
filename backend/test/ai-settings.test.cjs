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
test('create defaults do not leak into PATCH and prompt text remains unchanged', () => {
  const created = plainToInstance(CreatePersonaDto, {
    code: 'parcel',
    name: settings.name,
    promptText: settings.promptText,
  });
  assert.equal(validateSync(created).length, 0);
  assert.equal(created.promptText, settings.promptText);
  assert.equal(created.voiceId, null);
  assert.equal(created.turnWaitLevel, 'NORMAL');
  const patch = plainToInstance(UpdatePersonaDto, {
    expectedVersion: 1,
    expectedDraftRevision: null,
    promptText: '새 본문',
  });
  assert.equal(validateSync(patch).length, 0);
  for (const field of ['voiceId', 'speakingRate', 'turnWaitLevel', 'name'])
    assert.equal(patch[field], undefined);
  for (const input of [
    { name: null },
    { promptText: ' \n\t' },
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
