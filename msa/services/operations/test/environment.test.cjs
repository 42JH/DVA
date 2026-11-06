const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvironment } = require('../dist/config/environment');
const valid = { DB_HOST: 'db', DB_USER: 'operations_app', DB_PASSWORD: 'private-secret', DB_NAME: 'operations_db' };

test('operations requires its DB, preserves exact origins and validates ports', () => {
  const env = validateEnvironment({ ...valid, CORS_ORIGINS: ' https://example.com , http://localhost:5173 ' });
  assert.equal(env.PORT, 3005);
  assert.deepEqual(env.CORS_ORIGINS, ['https://example.com', 'http://localhost:5173']);
  for (const extra of [{ DB_PORT: '0' }, { PORT: '65536' }, { DB_PORT: '5432x' },
    { CORS_ORIGINS: 'https://example.com/path' }, { SWAGGER_ENABLED: 'yes' }, { NODE_ENV: {} },
    { CUSTOMER_AUTH_TOKEN: 'too-short' }, { CUSTOMER_AUTH_TOKEN: 'x'.repeat(257) },
    { CUSTOMER_AUTH_TOKEN: 'x'.repeat(32) + '\n' }, { CUSTOMER_URL: {} },
    { CUSTOMER_URL: 'http://user:password@customer:3001' }, { CUSTOMER_URL: 'file:///tmp/audit' },
    { CUSTOMER_URL: 'http://customer:3001/path' },{CONSULTATION_AUTH_TOKEN:'short'},
    {CONSULTATION_AUTH_TOKEN:{}},{CONSULTATION_AUTH_TOKEN:'x'.repeat(257)},{CONSULTATION_AUTH_TOKEN:'x'.repeat(32)+'\n'},
    {CONSULTATION_URL:{}},{CONSULTATION_URL:'http://user:private@consultation:3004'},
    {CONSULTATION_URL:'http://consultation:3004/path'},{CONSULTATION_URL:'file:///private'}]) {
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

test('persona integration is optional and accepts only the original URL/token format', () => {
  assert.equal(validateEnvironment(valid).AI_AGENT_URL, undefined);
  assert.equal(validateEnvironment(valid).AI_PERSONA_TOKEN, undefined);
  const configured = validateEnvironment({ ...valid, AI_AGENT_URL: 'https://agent.example/base/', AI_PERSONA_TOKEN: 'a'.repeat(32) });
  assert.equal(configured.AI_AGENT_URL, 'https://agent.example/base');
  assert.equal(configured.AI_PERSONA_TOKEN, 'a'.repeat(32));
  assert.equal(validateEnvironment({ ...valid, AI_PERSONA_TOKEN: '' }).AI_PERSONA_TOKEN, undefined);
  for (const extra of [{ AI_AGENT_URL: {} }, { AI_AGENT_URL: 'file:///private' },
    { AI_AGENT_URL: 'https://user:private@agent.example' }, { AI_AGENT_URL: 'http://agent:8000?secret=private' },
    { AI_AGENT_URL: 'http://agent:8000#private' }, { AI_PERSONA_TOKEN: 'private-short' },
    { AI_PERSONA_TOKEN: 'x'.repeat(32) + '\n' }, { AI_PERSONA_TOKEN: '가'.repeat(32) }]) {
    assert.throws(() => validateEnvironment({ ...valid, ...extra }), (error) => {
      assert.ok(error.fields.includes(Object.keys(extra)[0]));
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});

test('auth proxy trust is bounded and AI business credentials retain the source validation', () => {
  assert.equal(validateEnvironment(valid).AUTH_PROXY_HOPS, 0);
  assert.equal(validateEnvironment(valid).AI_BUSINESS_TOKEN, undefined);
  for (const value of ['0', '1', '2']) assert.equal(validateEnvironment({ ...valid, AUTH_PROXY_HOPS: value }).AUTH_PROXY_HOPS, Number(value));
  for (const value of ['-1', '3', '01', 1, {}, '1.0']) assert.throws(() => validateEnvironment({ ...valid, AUTH_PROXY_HOPS: value }), /AUTH_PROXY_HOPS/);
  for (const value of ['', 'x'.repeat(32)]) assert.equal(validateEnvironment({ ...valid, AI_BUSINESS_TOKEN: value }).AI_BUSINESS_TOKEN, value || undefined);
  for (const value of ['short', '가'.repeat(32), 'x'.repeat(32) + '\n', {}]) assert.throws(() => validateEnvironment({ ...valid, AI_BUSINESS_TOKEN: value }), /AI_BUSINESS_TOKEN/);
});

test('FAQ token is optional, preserves original bytes and needs its original AI URL when enabled', () => {
  assert.equal(validateEnvironment(valid).AI_FAQ_TOKEN, undefined);
  assert.equal(validateEnvironment({ ...valid, AI_FAQ_TOKEN: '' }).AI_FAQ_TOKEN, undefined);
  const token='faq-token-'.padEnd(40,'x');
  assert.equal(validateEnvironment({ ...valid, AI_AGENT_URL:'http://ai:8000', AI_FAQ_TOKEN:token }).AI_FAQ_TOKEN,token);
  assert.throws(() => validateEnvironment({ ...valid, AI_FAQ_TOKEN:token }),/AI_AGENT_URL/);
  for (const value of ['short', {}, '가'.repeat(32), 'x'.repeat(32)+'\n'])
    assert.throws(() => validateEnvironment({ ...valid, AI_AGENT_URL:'http://ai:8000', AI_FAQ_TOKEN:value }),/AI_FAQ_TOKEN/);
});

 test('order audit recovery is optional and only accepts a service origin',()=> {
  assert.equal(validateEnvironment(valid).ORDER_URL,undefined);
  assert.equal(validateEnvironment({...valid,ORDER_URL:'http://order:3002'}).ORDER_URL,'http://order:3002');
  for(const ORDER_URL of [{},'file:///private','http://user:private@order:3002','http://order:3002/path','http://order:3002?token=private'])
    assert.throws(()=>validateEnvironment({...valid,ORDER_URL}),error=>error.fields.includes('ORDER_URL')&&!error.message.includes('private'));
});
