// Import-time config validation must also run in unit/E2E builds without a live DB.
Object.assign(process.env, {
  AI_BUSINESS_TOKEN: 'local-test-only-ai-token-'.padEnd(64, 'a'),
  NODE_ENV: 'test', DB_HOST: 'unused', DB_USER: 'test', DB_PASSWORD: 'test',
  DB_NAME: 'unused', SWAGGER_ENABLED: 'true', CORS_ORIGINS: 'http://localhost:5173',
  OPERATIONS_URL: 'http://operations:3005', CUSTOMER_AUTH_TOKEN: 'local-test-only-token-'.padEnd(40, 'a'),
});
Object.assign(process.env, { DELIVERY_URL:'http://delivery:3003',CUSTOMER_URL: 'http://customer:3001', CONSULTATION_URL: 'http://consultation:3004' });
