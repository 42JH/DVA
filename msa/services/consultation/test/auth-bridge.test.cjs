require('reflect-metadata');
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { AuthService } = require('../dist/auth/auth.service');
const { ApiException } = require('../dist/common/errors/api.exception');
const { validateEnvironment } = require('../dist/config/environment');
let server, client, mode, requests = 0;
const token = 'a'.repeat(64);
const serviceToken = 'local-test-only-token-'.padEnd(40, 'b');
const admin = { adminUserSeq: 1, loginId: 'operator', name: '운영자', role: 'OPERATOR', status: 'ACTIVE',
  createdAt: new Date().toISOString(), lastLoginAt: null };
before(async () => {
  server = createServer(async (request, response) => {
    requests++;
    assert.equal(request.headers.authorization, 'Bearer ' + serviceToken);
    assert.equal(request.headers.cookie, undefined);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    if (mode === 'timeout') return;
    if (request.url === '/operations/health/ready') { response.writeHead(mode === 'unready' ? 503 : 200).end('{}'); return; }
    if (request.url === '/internal/events') { assert.deepEqual(body,{}); response.writeHead(400).end('{}'); return; }
    assert.equal(request.url, '/internal/auth/session');
    assert.equal(request.method, 'POST');
    assert.ok(body.sessionToken === token || body.sessionToken === '');
    if (mode === 'redirect') { response.writeHead(307, { Location: '/exfiltrate' }).end(); return; }
    response.setHeader('Content-Type', mode === 'html' ? 'text/html' : 'application/json');
    if (typeof mode === 'number') { response.writeHead(mode).end('{}'); return; }
    if (body.sessionToken === '') { response.writeHead(400).end('{}'); return; }
    response.end(mode === 'oversized' ? 'x'.repeat(9000) : mode === 'json' ? '{' :
      JSON.stringify(mode === 'invalid' ? { ...admin, status: 'PENDING' } : { ...admin, passwordHash: 'must-not-escape' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { OPERATIONS_URL: `http://127.0.0.1:${server.address().port}`, CONSULTATION_AUTH_TOKEN: serviceToken };
  client = new AuthService({ get: name => config[name] });
});
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
const rejects = status => error => error instanceof ApiException && error.getStatus() === status;
test('validates service authentication and PBX/S3 settings without exposing credentials', () => {
  const valid = { DB_HOST: 'db', DB_USER: 'consultation_app', DB_PASSWORD: 'private-password', DB_NAME: 'consultation_db',
    OPERATIONS_URL: 'http://operations:3005', CONSULTATION_AUTH_TOKEN: serviceToken };
  assert.equal(validateEnvironment(valid).PORT, 3004);
  for (const extra of [{ OPERATIONS_URL: '' }, { OPERATIONS_URL: 'http://user:password@operations:3005' },
    { OPERATIONS_URL: 'http://operations:3005/path' }, { OPERATIONS_URL: 'file:///tmp/auth' },
    { CONSULTATION_AUTH_TOKEN: '' }, { CONSULTATION_AUTH_TOKEN: 'x'.repeat(257) }, { CONSULTATION_AUTH_TOKEN: serviceToken+'\n' },
    { PBX_WEBHOOK_TOKEN:'short' },{ PBX_WEBHOOK_TOKEN:'x'.repeat(32)+'\n' },{ AWS_REGION:{} },{ AWS_REGION:'invalid' },
    { S3_RECORDINGS_BUCKET:'Invalid_private_bucket' },{ RECORDING_ALLOWED_HOSTS:'127.0.0.1' },
    { RECORDING_ALLOWED_HOSTS:'https://recordings.example.test' },{ RECORDING_MATCH_WINDOW_SECONDS:'0' },{ RECORDING_MATCH_WINDOW_SECONDS:'301' }]) {
    assert.throws(() => validateEnvironment({ ...valid, ...extra }), error => {
      assert.ok(!error.message.includes(valid.DB_PASSWORD));
      assert.ok(!error.message.includes(serviceToken));
      return Object.keys(extra).some(key=>error.fields.includes(key));
    });
  }
});
test('malformed or duplicate-cookie tokens cannot trigger an internal request', async () => {
  const before = requests;
  for (const value of [undefined, '', 'invalid', token + ';' + token]) await assert.rejects(client.authenticate(value), rejects(401));
  assert.equal(requests, before);
});
test('uses current operations identity on every request and excludes extra sensitive fields', async () => {
  mode = 'valid';
  const first = await client.authenticate(token);
  assert.equal(first.role, 'OPERATOR');
  assert.equal(first.passwordHash, undefined);
  assert.ok(first.createdAt instanceof Date);
  admin.role = 'SUPERVISOR';
  assert.equal((await client.authenticate(token)).role, 'SUPERVISOR');
  mode = 401;
  await assert.rejects(client.authenticate(token), rejects(401));
});
test('fails closed on service errors, redirects, malformed identities and oversized responses', async () => {
  for (mode of [403, 500, 503, 'html', 'json', 'invalid', 'oversized', 'redirect']) {
    await assert.rejects(client.authenticate(token), rejects(500));
  }
});
test('bounds stalled requests and does not turn outages into an unauthenticated AI call', async () => {
  mode = 'timeout';
  await assert.rejects(client.authenticate(token), rejects(500));
});
test('readiness checks both the operations DB and acceptance of the internal token', async () => {
  mode = 'valid'; await client.readiness();
  for (mode of ['unready', 403, 404]) await assert.rejects(client.readiness());
});
