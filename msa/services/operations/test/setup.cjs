// Import-time config validation must also run in unit/E2E builds without a live DB.
Object.assign(process.env, {
  NODE_ENV: 'test', DB_HOST: 'unused', DB_USER: 'test', DB_PASSWORD: 'test',
  DB_NAME: 'unused', SWAGGER_ENABLED: 'true', CORS_ORIGINS: 'http://localhost:5173',
});
