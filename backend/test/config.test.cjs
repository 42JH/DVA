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
  assert.match(result.stdout + result.stderr, /Invalid environment variables: DB_PASSWORD/);
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
