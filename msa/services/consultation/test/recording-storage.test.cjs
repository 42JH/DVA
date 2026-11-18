require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const { EventEmitter } = require('node:events');
const { S3Client } = require('@aws-sdk/client-s3');
const { ConfigService } = require('@nestjs/config');
const {
  RecordingStorage,
  recordingSource,
  publicRecordingAddress,
} = require('../dist/webhooks/pbx/recording-storage');
const { callerPhone } = require('../dist/common/caller-phone');
const host = 'recordings.example.test';
const source = `https://${host}/call.mp3?signed=private-test-value`;
const config = () =>
  new ConfigService({
    AWS_REGION: 'ap-northeast-2',
    S3_RECORDINGS_BUCKET: 'test-recordings',
    RECORDING_ALLOWED_HOSTS: [host],
  });

test('playback uses the source SDK signing lifetime and isolates recording errors',async t=>{
  const {HeadObjectCommand}=require('@aws-sdk/client-s3');
  const {RecordingPlaybackService}=require('../dist/consultations/recording-playback.service');
  const settings=config(),service=new RecordingPlaybackService(settings);
  const actualNow=Date.now,fixed=Date.UTC(2026,10,10),failure={url:null,expiresAt:null,playbackError:'DEPENDENCY_UNAVAILABLE'};
  let credentials={accessKeyId:'http-test-only',secretAccessKey:'http-test-only-secret',sessionToken:'test-session',expiration:new Date(fixed+90000)},status=200,heads=0;
  const head=async command=>{
    assert.ok(command instanceof HeadObjectCommand);heads++;
    if(command.input.Key==='recordings/missing.wav'||status!==200)throw Object.assign(new Error('private playback secret'),{$metadata:{httpStatusCode:command.input.Key==='recordings/missing.wav'?404:status}});
    return{$metadata:{httpStatusCode:200}};
  };
  function useCredentials(value){
    service.s3.destroy();service.s3=new S3Client({region:'ap-northeast-2',credentials:value,maxAttempts:1});
    t.mock.method(service.s3,'send',head);
  }
  useCredentials(credentials);
  Date.now=()=>fixed;
  try{
    const key='recordings/한글.wav',short=await service.create(key),url=new URL(short.url);
    assert.equal(short.playbackError,null);assert.equal(short.expiresAt.getTime(),fixed+90000);
    assert.equal(url.protocol,'https:');assert.equal(decodeURIComponent(url.pathname),'/'+key);
    assert.equal(url.searchParams.get('X-Amz-Expires'),'90');assert.equal(url.searchParams.get('response-cache-control'),'no-store');
    assert.equal(url.searchParams.get('X-Amz-Security-Token'),'test-session');assert.match(url.searchParams.get('X-Amz-Signature'),/^[a-f0-9]{64}$/);
    credentials={accessKeyId:'http-test-only',secretAccessKey:'http-test-only-secret'};
    useCredentials(credentials);
    assert.equal(new URL((await service.create(key)).url).searchParams.get('X-Amz-Expires'),'300');
    credentials={...credentials,expiration:new Date(fixed+500)};useCredentials(credentials);assert.deepEqual(await service.create(key),failure);
    credentials={accessKeyId:'http-test-only',secretAccessKey:'http-test-only-secret'};
    useCredentials(credentials);
    for(status of [403,500,undefined])assert.deepEqual(await service.create(key),failure);
    status=200;
    const mixed=await Promise.all(['recordings/missing.wav',key].map(value=>service.create(value)));
    assert.deepEqual(mixed[0],{url:null,expiresAt:null,playbackError:'NOT_FOUND'});assert.equal(mixed[1].playbackError,null);
    settings.set('S3_RECORDINGS_BUCKET','');const before=heads;assert.deepEqual(await service.create(key),failure);assert.equal(heads,before);
    assert.ok(!JSON.stringify(mixed).includes('private playback secret'));
  }finally{Date.now=actualNow;service.onApplicationShutdown();}
});
async function server(t, handler) {
  const app = http.createServer(handler);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    app.closeAllConnections();
    return new Promise((resolve) => app.close(resolve));
  });
  return `http://127.0.0.1:${app.address().port}`;
}

test('recording sources require an exact HTTPS host; private/reserved DNS answers fail closed', () => {
  assert.equal(recordingSource(source, [host]).hostname, host);
  for (const value of [
    `http://${host}/a`,
    `https://${host}.evil.test/a`,
    `https://${host}:444/a`,
    `https://u:p@${host}/a`,
    `https://${host}/a#x`,
    'https://169.254.169.254/metadata',
  ])
    assert.throws(() => recordingSource(value, [host]));
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fe80::1',
    'fc00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])
    assert.equal(publicRecordingAddress(address), false, address);
  assert.equal(publicRecordingAddress('1.1.1.1'), true);
  assert.equal(publicRecordingAddress('2606:4700:4700::1111'), true);
  assert.equal(callerPhone('+821012345678'), '01012345678');
  assert.equal(callerPhone('00821012345678'), '01012345678');
  assert.equal(callerPhone('01012345678'), '01012345678');
  assert.equal(callerPhone('+12125551234'), '+12125551234');
});

test('SDK upload is private, checksummed and conditional; retry reuses the object after source expiry', async (t) => {
  const audio = Buffer.from('test audio bytes');
  const objects = new Map();
  let downloads = 0,
    uploads = 0;
  const endpoint = await server(t, async (req, res) => {
    const objectPath = new URL(req.url, 'http://s3.test').pathname;
    const stored = objects.get(objectPath);
    if (req.method === 'HEAD') {
      if (!stored) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        'content-length': stored.bytes.length,
        'x-amz-meta-call-session-seq': stored.callId,
      });
      res.end();
      return;
    }
    assert.equal(req.method, 'PUT');
    uploads++;
    assert.equal(req.headers['if-none-match'], '*');
    assert.equal(req.headers['x-amz-acl'], undefined);
    assert.ok(req.headers['x-amz-checksum-sha256']);
    assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 /);
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const bytes = Buffer.concat(chunks);
    assert.deepEqual(bytes, audio);
    objects.set(objectPath, { bytes, callId: req.headers['x-amz-meta-call-session-seq'] });
    res.writeHead(200, { etag: '"test-etag"' });
    res.end();
  });
  const downloadUrl = await server(t, (_req, res) => {
    downloads++;
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
    res.end(audio);
  });
  t.mock.method(https, 'get', (url, options, callback) => {
    assert.equal(url.hostname, host);
    assert.ok(options.signal);
    assert.equal(typeof options.lookup, 'function');
    return http.get(downloadUrl, { signal: options.signal }, callback);
  });
  const storage = new RecordingStorage(config());
  storage.s3.destroy();
  storage.s3 = new S3Client({
    region: 'ap-northeast-2',
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test-only', secretAccessKey: 'test-only' },
    maxAttempts: 1,
  });
  t.after(() => storage.onApplicationShutdown());
  const key = await storage.save('opaque-recording-id', 42, source);
  assert.match(key, /^recordings\/[a-f0-9]{64}$/);
  assert.equal(
    await storage.save('opaque-recording-id', 42, 'https://expired.invalid/no-longer-available'),
    key,
  );
  await assert.rejects(
    () => storage.save('opaque-recording-id', 43, source),
    /recording_object_conflict/,
  );
  assert.equal(downloads, 1);
  assert.equal(uploads, 1);
});

test('download rejects redirects, missing audio, empty/truncated bodies and byte limits', async (t) => {
  let status = 200,
    headers = {},
    body = Buffer.from('audio');
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(status, headers);
    res.end(body);
    if (headers['content-length'] === '100') res.destroy();
  });
  t.mock.method(https, 'get', (_url, options, callback) =>
    http.get(endpoint, { signal: options.signal }, callback),
  );
  const storage = new RecordingStorage(config());
  t.after(() => storage.onApplicationShutdown());
  for (const scenario of [
    {
      status: 302,
      headers: { location: 'http://127.0.0.1/private', 'content-type': 'audio/mpeg' },
      body,
    },
    { status: 403, headers: { 'content-type': 'audio/mpeg' }, body },
    { status: 200, headers: { 'content-type': 'text/html' }, body },
    { status: 200, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.alloc(0) },
    {
      status: 200,
      headers: { 'content-type': 'audio/mpeg', 'content-length': String(32 * 1024 * 1024 + 1) },
      body,
    },
    { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '100' }, body },
    {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
      body: Buffer.alloc(32 * 1024 * 1024 + 1),
    },
  ]) {
    ({ status, headers, body } = scenario);
    await assert.rejects(() => storage.download(new URL(source)));
  }
});

test('DNS checks apply to the addresses actually passed to the connection', async (t) => {
  let answers = [{ address: '127.0.0.1', family: 4 }];
  t.mock.method(dns, 'lookup', (_host, options, callback) => {
    assert.equal(options.all, true);
    callback(null, answers);
  });
  t.mock.method(https, 'get', (_url, options) => {
    const request = new EventEmitter();
    queueMicrotask(() =>
      options.lookup(host, { all: true }, (error, addresses) => {
        if (error) request.emit('error', error);
        else {
          assert.deepEqual(addresses, answers);
          request.emit('error', new Error('public-lookup-verified'));
        }
      }),
    );
    return request;
  });
  const storage = new RecordingStorage(config());
  t.after(() => storage.onApplicationShutdown());
  await assert.rejects(() => storage.download(new URL(source)), /recording_address_not_public/);
  answers = [
    { address: '1.1.1.1', family: 4 },
    { address: '::1', family: 6 },
  ];
  await assert.rejects(() => storage.download(new URL(source)), /recording_address_not_public/);
  answers = [{ address: '1.1.1.1', family: 4 }];
  await assert.rejects(
    () => storage.download(new URL(source)),
    (error) =>
      error.code === 'DOWNLOAD_UNAVAILABLE' &&
      error.retryable &&
      !error.message.includes('public-lookup-verified'),
  );
});

test('source HTTP failures expose only bounded retry codes while unsafe redirects remain terminal', async (t) => {
  let status = 403;
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end('private provider URL and credentials');
  });
  t.mock.method(https, 'get', (_url, options, callback) =>
    http.get(endpoint, { signal: options.signal }, callback),
  );
  const storage = new RecordingStorage(config());
  t.after(() => storage.onApplicationShutdown());
  for (const [httpStatus, code, retryable] of [
    [401, 'SOURCE_ACCESS_DENIED', true],
    [403, 'SOURCE_ACCESS_DENIED', true],
    [404, 'SOURCE_NOT_FOUND', true],
    [410, 'SOURCE_NOT_FOUND', true],
    [429, 'SOURCE_RATE_LIMITED', true],
    [500, 'SOURCE_UNAVAILABLE', true],
    [503, 'SOURCE_UNAVAILABLE', true],
    [302, 'DOWNLOAD_REJECTED', false],
  ]) {
    status = httpStatus;
    await assert.rejects(
      () => storage.download(new URL(source)),
      (error) =>
        error.code === code && error.retryable === retryable && !error.message.includes('private'),
    );
  }
});

test('a stalled download times out rather than holding the worker forever', async (t) => {
  const endpoint = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.write('partial');
  });
  t.mock.method(https, 'get', (_url, _options, callback) =>
    http.get(endpoint, { signal: AbortSignal.timeout(30) }, callback),
  );
  const storage = new RecordingStorage(config());
  t.after(() => storage.onApplicationShutdown());
  await assert.rejects(() => storage.download(new URL(source)));
});

test('retention erases every exact object version and delete marker and propagates partial deletion failures', async (t) => {
  const storage = new RecordingStorage(config());
  t.after(() => storage.onApplicationShutdown());
  const key = 'recordings/expired';
  let remaining = true,
    denied = false;
  const deleted = [];
  t.mock.method(storage.s3, 'send', async (command) => {
    assert.equal(command.input.Bucket, 'test-recordings');
    if (command.constructor.name === 'DeleteObjectCommand') {
      assert.equal(command.input.Key, key);
      return {};
    }
    if (command.constructor.name === 'ListObjectVersionsCommand')
      return remaining
        ? {
            Versions: [
              { Key: key, VersionId: 'v1' },
              { Key: key + '-other', VersionId: 'other' },
            ],
            DeleteMarkers: [{ Key: key, VersionId: 'marker' }],
          }
        : {};
    assert.equal(command.constructor.name, 'DeleteObjectsCommand');
    deleted.push(...command.input.Delete.Objects);
    if (denied) return { Errors: [{ Key: key, Code: 'AccessDenied' }] };
    remaining = false;
    return {};
  });
  await storage.erase(key);
  assert.deepEqual(deleted, [
    { Key: key, VersionId: 'v1' },
    { Key: key, VersionId: 'marker' },
  ]);
  remaining = true;
  denied = true;
  await assert.rejects(storage.erase(key), /recording_version_delete_failed/);
});
