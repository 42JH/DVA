// Import-time config validation must also run in unit/E2E builds without a live DB.
Object.assign(process.env, {
  NODE_ENV: 'test', DB_HOST: 'unused', DB_USER: 'test', DB_PASSWORD: 'test',
  DB_NAME: 'unused', SWAGGER_ENABLED: 'true', CORS_ORIGINS: 'http://localhost:5173',
  OPERATIONS_URL: 'http://operations:3005', CONSULTATION_AUTH_TOKEN: 'local-test-only-token-'.padEnd(40, 'a'),
});

process.env.PBX_WEBHOOK_TOKEN = 'local-test-pbx-token-'.padEnd(40, 'p');
