import { resolve } from 'node:path';

export function configuration(env = process.env) {
  const invalid = [];
  const localTest = env.NODE_ENV === 'test';
  const required = (name, pattern) => {
    const value = env[name] ?? '';
    if (!pattern.test(value)) invalid.push(name);
    return value;
  };
  if (env.PAYMENT_TEST_ENABLED !== 'true') invalid.push('PAYMENT_TEST_ENABLED');
  const publicUrl = required('PAYMENT_TEST_PUBLIC_URL', /\S/);
  const clientKey = required('TOSS_TEST_CLIENT_KEY', /^test_gck_[A-Za-z0-9_-]+$/);
  const secretKey = required('TOSS_TEST_SECRET_KEY', /^test_gsk_[A-Za-z0-9_-]+$/);
  const operatorToken = required('PAYMENT_TEST_OPERATOR_TOKEN', /^[A-Za-z0-9_-]{32,128}$/);
  const webhook = required('MATTERMOST_WEBHOOK_URL', /\S/);
  const tossUrl = env.PAYMENT_TEST_TOSS_BASE_URL || 'https://api.tosspayments.com';
  function url(value, name) {
    try {
      const parsed = new URL(value);
      const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
      if (
        (parsed.protocol !== 'https:' && !(localTest && loopback && parsed.protocol === 'http:')) ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        invalid.push(name);
      return parsed;
    } catch {
      invalid.push(name);
      return new URL('https://invalid.example');
    }
  }
  const publicAddress = url(publicUrl, 'PAYMENT_TEST_PUBLIC_URL');
  if (publicAddress.pathname !== '/payment-test') invalid.push('PAYMENT_TEST_PUBLIC_URL');
  const webhookAddress = url(webhook, 'MATTERMOST_WEBHOOK_URL');
  if (!localTest && !/^\/hooks\/[A-Za-z0-9_-]+$/.test(webhookAddress.pathname))
    invalid.push('MATTERMOST_WEBHOOK_URL');
  const tossAddress = url(tossUrl, 'PAYMENT_TEST_TOSS_BASE_URL');
  if (
    tossUrl !== 'https://api.tosspayments.com' &&
    !(localTest && ['127.0.0.1', 'localhost', '[::1]'].includes(tossAddress.hostname))
  )
    invalid.push('PAYMENT_TEST_TOSS_BASE_URL');
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (!localTest && port === 0))
    invalid.push('PORT');
  const dataDir = env.PAYMENT_TEST_DATA_DIR || '/data';
  if (resolve(dataDir) !== dataDir) invalid.push('PAYMENT_TEST_DATA_DIR');
  if (invalid.length) throw new Error(`Invalid configuration: ${[...new Set(invalid)].join(', ')}`);
  return Object.freeze({
    publicUrl,
    clientKey,
    secretKey,
    operatorToken,
    webhook,
    tossUrl,
    port,
    dataDir,
  });
}
