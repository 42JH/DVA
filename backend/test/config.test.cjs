const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { validateEnvironment } = require('../dist/config/environment');

const valid = {
  NODE_ENV: 'test',
  DB_HOST: 'db',
  DB_USER: 'test_user',
  DB_PASSWORD: 'test-only-not-a-real-password',
  DB_NAME: 'dva_webhook_test',
  AI_AGENT_URL: 'http://ai:8000',
};

test('customer business token is optional, validated and never echoed in configuration errors', () => {
  assert.equal(validateEnvironment(valid).AI_BUSINESS_TOKEN, undefined);
  assert.equal(
    validateEnvironment({ ...valid, AI_BUSINESS_TOKEN: '' }).AI_BUSINESS_TOKEN,
    undefined,
  );
  const token = 'b'.repeat(32);
  assert.equal(
    validateEnvironment({ ...valid, AI_BUSINESS_TOKEN: token }).AI_BUSINESS_TOKEN,
    token,
  );
  for (const value of ['short', token + ' ', token + '\n', '한'.repeat(32), 123])
    assert.throws(
      () => validateEnvironment({ ...valid, AI_BUSINESS_TOKEN: value }),
      (error) => {
        assert.equal(error.message, 'Invalid environment variables: AI_BUSINESS_TOKEN');
        assert.ok(!error.message.includes(String(value)));
        return true;
      },
    );
});

test('FAQ notification token is optional, validated and never echoed in configuration errors', () => {
  assert.equal(validateEnvironment(valid).AI_FAQ_TOKEN, undefined);
  assert.equal(validateEnvironment({ ...valid, AI_FAQ_TOKEN: '' }).AI_FAQ_TOKEN, undefined);
  const token = 'faq-test-only-token-with-at-least-32-characters';
  assert.equal(validateEnvironment({ ...valid, AI_FAQ_TOKEN: token }).AI_FAQ_TOKEN, token);
  for (const value of ['short', token + ' ', token + '\n', '한'.repeat(32), 123])
    assert.throws(
      () => validateEnvironment({ ...valid, AI_FAQ_TOKEN: value }),
      (error) => {
        assert.equal(error.message, 'Invalid environment variables: AI_FAQ_TOKEN');
        return true;
      },
    );
});

test('recording config is disabled until a bucket is set and bounds correlation settings', () => {
  const defaults = validateEnvironment(valid);
  assert.equal(defaults.S3_RECORDINGS_BUCKET, undefined);
  assert.equal(defaults.AWS_REGION, 'ap-northeast-2');
  assert.equal(defaults.RECORDING_MATCH_WINDOW_SECONDS, 30);
  assert.deepEqual(defaults.RECORDING_ALLOWED_HOSTS, [
    'dvercorp-aicc-connect-dev-recordings.s3.ap-northeast-2.amazonaws.com',
  ]);
  const enabled = validateEnvironment({
    ...valid,
    S3_RECORDINGS_BUCKET: 'dva-private-recordings',
    RECORDING_MATCH_WINDOW_SECONDS: '10',
    RECORDING_ALLOWED_HOSTS: 'records.example.test,second.example.test',
  });
  assert.equal(enabled.RECORDING_MATCH_WINDOW_SECONDS, 10);
  assert.equal(enabled.RECORDING_ALLOWED_HOSTS.length, 2);
  for (const settings of [
    { AWS_REGION: 'https://wrong.example' },
    { S3_RECORDINGS_BUCKET: 'arn:aws:s3:::secret-bucket' },
    { RECORDING_ALLOWED_HOSTS: '*' },
    { RECORDING_ALLOWED_HOSTS: '127.0.0.1' },
    { RECORDING_ALLOWED_HOSTS: 'https://records.example.test' },
    { RECORDING_MATCH_WINDOW_SECONDS: '0' },
    { RECORDING_MATCH_WINDOW_SECONDS: '301' },
    { RECORDING_MATCH_WINDOW_SECONDS: '1.5' },
  ])
    assert.throws(
      () => validateEnvironment({ ...valid, ...settings }),
      /^EnvironmentValidationError: Invalid environment variables:/,
    );
});

test('configuration parses ports and exact CORS origins; production docs default off', () => {
  const config = validateEnvironment({
    ...valid,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://13.209.59.180,http://localhost:5173',
    DB_PORT: '5433',
  });
  assert.equal(config.PORT, 3000);
  assert.equal(config.DB_PORT, 5433);
  assert.equal(config.SWAGGER_ENABLED, false);
  assert.deepEqual(config.CORS_ORIGINS, ['https://13.209.59.180', 'http://localhost:5173']);
});

test('missing/invalid configuration fails without including input values', () => {
  for (const invalid of [
    { DB_PASSWORD: '' },
    { DB_HOST: '' },
    { PORT: '0' },
    { DB_PORT: '65536' },
    { PORT: '3e3' },
    { NODE_ENV: 'staging' },
    { SWAGGER_ENABLED: 'yes' },
    { AI_AGENT_URL: 'http://user:secret@ai:8000' },
    { CORS_ORIGINS: '*' },
    { CORS_ORIGINS: 'https://frontend.invalid/path' },
    { PBX_WEBHOOK_TOKEN: 'short-secret' },
  ]) {
    assert.throws(
      () => validateEnvironment({ ...valid, ...invalid }),
      (error) => {
        assert.match(error.message, /^Invalid environment variables:/);
        assert.ok(!error.message.includes(valid.DB_PASSWORD));
        assert.ok(!error.message.includes('short-secret'));
        return true;
      },
    );
  }
});

test('the actual process exits before listening when a required setting is missing', () => {
  const result = spawnSync(process.execPath, ['dist/main.js'], {
    cwd: require('node:path').join(__dirname, '..'),
    env: { ...process.env, ...valid, DB_PASSWORD: '' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(result.status, 1, result.error?.message);
  const records = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(
    records.some(
      (record) =>
        record.event === 'backend_startup_failed' && record.invalidFields.includes('DB_PASSWORD'),
    ),
  );
  assert.ok(!(result.stdout + result.stderr).includes(valid.DB_PASSWORD));
});

test('Dver requires HTTPS, rejects credential-bearing URLs and accepts empty keys as disabled', () => {
  const disabled = validateEnvironment(valid);
  assert.equal(disabled.DVER_API_URL, 'https://public-n8n.dvercorp.co.kr:47514/webhook/parcel');
  assert.equal(disabled.DVER_API_KEY, undefined);
  assert.equal(validateEnvironment({ ...valid, DVER_API_KEY: '' }).DVER_API_KEY, undefined);
  assert.equal(
    validateEnvironment({ ...valid, DVER_API_URL: 'http://127.0.0.1:1234/parcel' }).DVER_API_URL,
    'http://127.0.0.1:1234/parcel',
  );
  for (const invalid of [
    { DVER_API_URL: '' },
    { DVER_API_URL: 'http://provider.invalid/parcel' },
    { DVER_API_URL: 'https://user:secret@provider.invalid/parcel' },
    { DVER_API_URL: 'https://provider.invalid/parcel?key=secret' },
    { DVER_API_URL: 'https://provider.invalid/parcel#fragment' },
    { NODE_ENV: 'production', DVER_API_URL: 'http://127.0.0.1:1234/parcel' },
    { DVER_API_KEY: 'key\r\nInjected: value' },
    { DVER_API_KEY: ' key ' },
    { DVER_API_KEY: 123 },
  ])
    assert.throws(
      () => validateEnvironment({ ...valid, ...invalid }),
      (error) =>
        /^Invalid environment variables: DVER_/.test(error.message) &&
        !error.message.includes('secret'),
    );
});
