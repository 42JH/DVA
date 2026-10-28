require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ConfigService } = require('@nestjs/config');
const { S3Client } = require('@aws-sdk/client-s3');
const presigner = require('@aws-sdk/s3-request-presigner');
const { RecordingPlaybackService } = require('../dist/consultations/recording-playback.service');
const objectKey = 'recordings/한글 audio+1.mp3';
const credentials = {
  accessKeyId: 'playback-test-only',
  secretAccessKey: 'playback-test-only-secret',
};

async function setup(t, options = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method,
      path: new URL(req.url, 'http://test').pathname,
      signed: req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 '),
    });
    res.writeHead(options.status ?? 200, { 'content-length': 4, 'content-type': 'audio/mpeg' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = new ConfigService({
    AWS_REGION: 'ap-northeast-2',
    S3_RECORDINGS_BUCKET: 'test-recordings',
  });
  const service = new RecordingPlaybackService(config);
  service.s3.destroy();
  service.s3 = new S3Client({
    region: 'ap-northeast-2',
    endpoint: `http://127.0.0.1:${server.address().port}`,
    forcePathStyle: true,
    credentials: options.credentials ?? credentials,
    maxAttempts: 1,
  });
  t.after(async () => {
    service.onApplicationShutdown();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { service, config, requests };
}
const failure = async (promise, code) =>
  assert.deepEqual(await promise, { url: null, expiresAt: null, playbackError: code });

test('playback performs an authenticated S3 HEAD and signs a private HTTPS GET for five minutes', async (t) => {
  const { service, requests } = await setup(t);
  const before = Date.now();
  const result = await service.create(objectKey);
  assert.equal(result.playbackError, null);
  const url = new URL(result.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'test-recordings.s3.ap-northeast-2.amazonaws.com');
  assert.equal(decodeURIComponent(url.pathname), '/' + objectKey);
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.match(url.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
  assert.equal(url.searchParams.get('response-cache-control'), 'no-store');
  assert.ok(result.expiresAt.getTime() >= before - 1000 + 300000);
  assert.ok(result.expiresAt.getTime() <= Date.now() + 300000);
  assert.deepEqual(requests, [
    {
      method: 'HEAD',
      path: '/test-recordings/' + encodeURI(objectKey).replaceAll('+', '%2B'),
      signed: true,
    },
  ]);
  assert.equal(result.url.includes(credentials.secretAccessKey), false);
});

test('temporary credentials shorten both the signed URL and the returned expiration', async (t) => {
  const expiration = new Date(Math.floor(Date.now() / 1000) * 1000 + 60000);
  const { service } = await setup(t, {
    credentials: { ...credentials, sessionToken: 'temporary-test-only', expiration },
  });
  const result = await service.create(objectKey);
  const url = new URL(result.url);
  assert.ok(Number(url.searchParams.get('X-Amz-Expires')) > 0);
  assert.ok(Number(url.searchParams.get('X-Amz-Expires')) <= 60);
  assert.equal(url.searchParams.get('X-Amz-Security-Token'), 'temporary-test-only');
  assert.equal(result.expiresAt.toISOString(), expiration.toISOString());
});

test('missing bucket settings report an unavailable URL without contacting S3', async (t) => {
  const { service, config, requests } = await setup(t);
  config.set('S3_RECORDINGS_BUCKET', '');
  await failure(service.create(objectKey), 'DEPENDENCY_UNAVAILABLE');
  assert.equal(requests.length, 0);
});

test('missing S3 objects remain distinct from denied or unavailable storage', async (t) => {
  for (const status of [404, 403, 500]) {
    const { service } = await setup(t, { status });
    await failure(
      service.create(objectKey),
      status === 404 ? 'NOT_FOUND' : 'DEPENDENCY_UNAVAILABLE',
    );
  }
});

test('network timeouts and expired credentials never return a playback URL', async (t) => {
  const { service } = await setup(t);
  t.mock.method(service.s3, 'send', async () => {
    throw new Error('private endpoint timeout');
  });
  await failure(service.create(objectKey), 'DEPENDENCY_UNAVAILABLE');
  const expired = await setup(t, {
    credentials: { ...credentials, expiration: new Date(Date.now() - 10000) },
  });
  await failure(expired.service.create(objectKey), 'DEPENDENCY_UNAVAILABLE');
});

test('signing errors redact credentials and object paths', async (t) => {
  const { service } = await setup(t);
  t.mock.method(presigner, 'getSignedUrl', async () => {
    throw new Error(objectKey + credentials.secretAccessKey);
  });
  const result = await service.create(objectKey);
  assert.deepEqual(result, { url: null, expiresAt: null, playbackError: 'DEPENDENCY_UNAVAILABLE' });
  const body = JSON.stringify(result);
  assert.equal(body.includes(objectKey), false);
  assert.equal(body.includes(credentials.secretAccessKey), false);
});

test('reloading a recording signs a fresh URL and expiration instead of reusing a cached URL', async (t) => {
  const { service } = await setup(t);
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, 'now', () => now);
  const first = await service.create(objectKey);
  t.mock.method(Date, 'now', () => now + 60000);
  const refreshed = await service.create(objectKey);
  assert.equal(first.playbackError, null);
  assert.equal(refreshed.playbackError, null);
  assert.notEqual(refreshed.url, first.url);
  assert.equal(refreshed.expiresAt.getTime() - first.expiresAt.getTime(), 60000);
});
