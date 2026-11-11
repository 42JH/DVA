// Unchanged source unit tests need the split service's mandatory peer configuration.
const environment = require('../dist/config/environment');
const validate = environment.validateEnvironment;
environment.validateEnvironment = raw => validate({
  OPERATIONS_URL: 'http://operations-app:3005', CUSTOMER_URL: 'http://customer-app:3001',
  CUSTOMER_AUTH_TOKEN: 'analysis-test-customer-'.padEnd(48, 'c'),
  CONSULTATION_AUTH_TOKEN: 'analysis-test-consultation-'.padEnd(48, 's'),
  ...raw,
});
