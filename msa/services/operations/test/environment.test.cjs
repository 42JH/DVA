const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvironment } = require('../dist/config/environment');
const valid = { DB_HOST: 'db', DB_USER: 'operations_app', DB_PASSWORD: 'private-secret', DB_NAME: 'operations_db' };

test('operations requires its DB, preserves exact origins and validates ports', () => {
  const env = validateEnvironment({ ...valid, CORS_ORIGINS: ' https://example.com , http://localhost:5173 ' });
  assert.equal(env.PORT, 3005);
  assert.deepEqual(env.CORS_ORIGINS, ['https://example.com', 'http://localhost:5173']);
  for (const extra of [{ DB_PORT: '0' }, { PORT: '65536' }, { DB_PORT: '5432x' },
    { CORS_ORIGINS: 'https://example.com/path' }, { SWAGGER_ENABLED: 'yes' }, { NODE_ENV: {} }]) {
    assert.throws(() => validateEnvironment({ ...valid, ...extra }), /Invalid environment variables/);
  }
});

test('invalid config reports field names without exposing submitted secrets', () => {
  assert.throws(() => validateEnvironment({ ...valid, DB_HOST: '' }), (error) => {
    assert.deepEqual(error.fields, ['DB_HOST']);
    assert.ok(!error.message.includes(valid.DB_PASSWORD));
    return true;
  });
});
