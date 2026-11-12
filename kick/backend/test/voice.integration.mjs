import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './dist/app.module.js';

process.env.ELEVENLABS_API_KEY = 'test-only';
const nativeFetch = globalThis.fetch;
const cloned = [];
const spoken = [];
const deleted = [];
let verified = false;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.elevenlabs.io') {
    return nativeFetch(input, init);
  }
  assert.equal(init.headers.get('xi-api-key'), 'test-only');
  if (url.pathname === '/v1/voices/add' && init.method === 'POST') {
    const name = init.body.get('name');
    assert.equal(init.body.get('files').type, 'audio/mpeg');
    cloned.push(name);
    const second = name === 'Kick kick-test-2';
    return Response.json({
      voice_id: second ? 'clone-2' : 'clone-1',
      requires_verification: second,
    });
  }
  if (init.method === 'GET') {
    assert.equal(url.pathname, '/v1/voices/clone-2');
    return Response.json({ voice_id: 'clone-2', voice_verification: { is_verified: verified } });
  }
  if (init.method === 'DELETE') {
    deleted.push(url.pathname);
    return Response.json({ status: 'ok' });
  }
  spoken.push(url.pathname);
  assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
  assert.deepEqual(JSON.parse(init.body), { text: '안녕하세요', model_id: 'eleven_flash_v2_5' });
  return new Response(Buffer.from(url.pathname), { headers: { 'content-type': 'audio/mpeg' } });
};

const app = await NestFactory.create(AppModule, { logger: false });
try {
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api/voice';
  const first = process.env.KICK_TEST_ACCOUNT_1_TOKEN;
  const second = process.env.KICK_TEST_ACCOUNT_2_TOKEN;
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  const clone = (token, consent) => {
    const form = new FormData();
    form.set('consent', consent);
    form.set(
      'audio',
      new Blob([Buffer.from('ID3 test sample')], { type: 'audio/mpeg' }),
      'sample.mp3',
    );
    return fetch(base, { method: 'POST', headers: auth(token), body: form });
  };
  const status = async (token) =>
    (await (await fetch(base, { headers: auth(token) })).json()).status;
  const speech = (token, text = '안녕하세요') =>
    fetch(base + '/speech', {
      method: 'POST',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });

  assert.equal((await fetch(base)).status, 401);
  assert.equal((await clone(first, 'false')).status, 400);
  assert.equal(cloned.length, 0);
  assert.equal((await clone(first, 'true')).status, 201);
  assert.equal((await clone(first, 'true')).status, 409);
  assert.equal((await clone(second, 'true')).status, 201);
  assert.deepEqual(cloned, ['Kick kick-test-1', 'Kick kick-test-2']);
  assert.equal(await status(second), 'VERIFICATION_REQUIRED');
  assert.equal((await speech(second)).status, 409);
  assert.equal((await speech(first, '가'.repeat(21))).status, 400);
  verified = true;
  assert.equal(await status(second), 'READY');
  for (const [token, expected] of [
    [first, 'clone-1'],
    [second, 'clone-2'],
  ]) {
    const response = await speech(token);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^audio\/mpeg/);
    assert.equal(await response.text(), `/v1/text-to-speech/${expected}`);
  }
  assert.equal(spoken.length, 2);
  assert.equal((await fetch(base, { method: 'DELETE', headers: auth(first) })).status, 204);
  assert.deepEqual(deleted, ['/v1/voices/clone-1']);
  assert.equal(await status(first), 'NOT_REGISTERED');
  assert.equal(await status(second), 'READY');
  console.log('Kick account voice and speech integration passed (ElevenLabs mocked)');
} finally {
  await app.close();
  globalThis.fetch = nativeFetch;
}
