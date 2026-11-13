import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './dist/app.module.js';

process.env.ELEVENLABS_API_KEY = 'test-only';
process.env.KICK_TTS_FIXED_SETTINGS = 'false';
const nativeFetch = globalThis.fetch;
const cloned = [];
const spoken = [];
const deleted = [];
let verified = false;
let requiresPaidPlan = true;
let pcmMode = 'normal';
let finishPcm;
let pcmCancelled;
const maxLengthText = '가'.repeat(50);
const settings = {
  model: 'eleven_multilingual_v2',
  speed: 0.85,
  stability: 0.35,
  similarityBoost: 0.8,
  style: 0.25,
};
let expectedSettings;
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.elevenlabs.io') {
    return nativeFetch(input, init);
  }
  assert.equal(init.headers.get('xi-api-key'), 'test-only');
  if (url.pathname === '/v1/voices/add' && init.method === 'POST') {
    const name = init.body.get('name');
    assert.equal(init.body.get('files').type, 'audio/mpeg');
    if (requiresPaidPlan) {
      return Response.json(
        { detail: { code: 'paid_plan_required', status: 'can_not_use_instant_voice_cloning' } },
        { status: 400 },
      );
    }
    cloned.push(name);
    assert.match(name, /^Kick kick-test-[1-5]$/);
    return Response.json({
      voice_id: `clone-${name.at(-1)}`,
      requires_verification: name === 'Kick kick-test-2',
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
  const { text, model_id: model, voice_settings: voiceSettings } = JSON.parse(init.body);
  assert.ok(text === '안녕하세요' || text === maxLengthText);
  assert.equal(model, expectedSettings?.model ?? 'eleven_flash_v2_5');
  assert.deepEqual(voiceSettings, expectedSettings?.voiceSettings);
  if (url.pathname.endsWith('/stream')) {
    assert.equal(url.pathname, '/v1/text-to-speech/clone-1/stream');
    assert.equal(url.searchParams.get('output_format'), 'pcm_16000');
    assert.equal(init.headers.get('accept'), 'audio/pcm');
    if (pcmMode === 'denied') return new Response('provider error', { status: 403 });
    if (pcmMode === 'empty')
      return new Response(new Uint8Array(), { headers: { 'content-type': 'audio/pcm' } });
    const pcm = new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2, 3));
        finishPcm = () => {
          if (pcmMode === 'broken') {
            controller.error(new Error('provider disconnected'));
            return;
          }
          controller.enqueue(Uint8Array.of(4));
          controller.close();
        };
      },
      cancel() {
        pcmCancelled?.();
      },
    });
    init.signal.addEventListener('abort', () => pcmCancelled?.(), { once: true });
    return new Response(pcm, { headers: { 'content-type': 'audio/pcm' } });
  }
  spoken.push(url.pathname);
  assert.equal(url.searchParams.get('output_format'), 'mp3_44100_128');
  return new Response(Buffer.from(url.pathname), { headers: { 'content-type': 'audio/mpeg' } });
};

const app = await NestFactory.create(AppModule, { logger: false });
try {
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()) + '/api/voice';
  const first = process.env.KICK_TEST_ACCOUNT_1_TOKEN;
  const second = process.env.KICK_TEST_ACCOUNT_2_TOKEN;
  const extraAccounts = [3, 4, 5].map((number) => [
    process.env[`KICK_TEST_ACCOUNT_${number}_TOKEN`],
    `clone-${number}`,
  ]);
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
  const stream = (token, body = { text: '안녕하세요' }, signal) =>
    fetch(base + '/speech/stream', {
      method: 'POST',
      headers: { ...auth(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(3_000),
    });

  assert.equal((await fetch(base)).status, 401);
  assert.equal((await clone(first, 'false')).status, 400);
  assert.equal(cloned.length, 0);
  assert.equal((await clone(first, 'true')).status, 402);
  assert.equal(await status(first), 'NOT_REGISTERED');
  requiresPaidPlan = false;
  assert.equal((await clone(first, 'true')).status, 201);
  assert.equal((await clone(first, 'true')).status, 409);
  assert.equal((await clone(second, 'true')).status, 201);
  for (const [token] of extraAccounts) {
    assert.equal(await status(token), 'NOT_REGISTERED');
    assert.equal((await clone(token, 'true')).status, 201);
    assert.equal(await status(token), 'READY');
  }
  assert.deepEqual(
    cloned,
    [1, 2, 3, 4, 5].map((number) => `Kick kick-test-${number}`),
  );
  assert.equal(await status(second), 'VERIFICATION_REQUIRED');
  assert.equal((await speech(second)).status, 409);
  assert.equal((await speech(first, '가'.repeat(51))).status, 400);
  assert.equal((await stream('0'.repeat(64))).status, 401);
  assert.equal((await stream(second)).status, 409);
  assert.equal((await stream(first, { text: '가'.repeat(51) })).status, 400);
  assert.equal((await stream(first, { text: '안녕하세요', voiceId: 'clone-2' })).status, 400);
  for (const invalid of [
    { speed: 1.21 },
    { stability: '0.35' },
    { similarityBoost: -0.1 },
    { model: 'eleven_v3' },
    { style: 0.2 },
  ]) {
    assert.equal((await stream(first, { text: '안녕하세요', settings: invalid })).status, 400);
  }
  verified = true;
  assert.equal(await status(second), 'READY');
  for (const [token, expected] of [[first, 'clone-1'], [second, 'clone-2'], ...extraAccounts]) {
    const response = await speech(token);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^audio\/mpeg/);
    assert.equal(await response.text(), `/v1/text-to-speech/${expected}`);
  }
  assert.equal(spoken.length, 5);
  const maxLengthMp3 = await speech(first, maxLengthText);
  assert.equal(maxLengthMp3.status, 200);
  await maxLengthMp3.arrayBuffer();

  pcmMode = 'denied';
  assert.equal((await stream(first)).status, 502);
  pcmMode = 'empty';
  assert.equal((await stream(first)).status, 502);
  pcmMode = 'normal';
  expectedSettings = {
    model: settings.model,
    voiceSettings: { speed: 0.85, stability: 0.35, similarity_boost: 0.8, style: 0.25 },
  };
  const pcmResponse = await stream(first, { text: maxLengthText, settings });
  expectedSettings = undefined;
  assert.equal(pcmResponse.status, 200);
  assert.equal(pcmResponse.headers.get('content-type'), 'audio/pcm');
  assert.equal(pcmResponse.headers.get('cache-control'), 'no-store');
  assert.equal(pcmResponse.headers.get('content-length'), null);
  const reader = pcmResponse.body.getReader();
  // Release the upstream tail only after the client has received bytes.
  assert.deepEqual((await reader.read()).value, Uint8Array.of(1, 2, 3));
  finishPcm();
  assert.deepEqual((await reader.read()).value, Uint8Array.of(4));
  assert.equal((await reader.read()).done, true);

  pcmMode = 'broken';
  const broken = (await stream(first)).body.getReader();
  assert.equal((await broken.read()).done, false);
  finishPcm();
  await assert.rejects(broken.read());

  pcmMode = 'normal';
  const abort = new AbortController();
  const cancelled = Promise.withResolvers();
  pcmCancelled = cancelled.resolve;
  const disconnected = (await stream(first, undefined, abort.signal)).body.getReader();
  assert.equal((await disconnected.read()).done, false);
  abort.abort();
  await Promise.race([
    cancelled.promise,
    setTimeout(3000, undefined, { ref: false }).then(() =>
      assert.fail('Upstream was not cancelled'),
    ),
  ]);
  pcmCancelled = undefined;

  process.env.KICK_TTS_FIXED_SETTINGS = 'true';
  expectedSettings = {
    model: 'eleven_multilingual_v2',
    voiceSettings: { speed: 0.92, stability: 0.75, similarity_boost: 0.9, style: 0.05 },
  };
  const fixedMp3 = await speech(first);
  assert.equal(fixedMp3.status, 200);
  assert.equal(await fixedMp3.text(), '/v1/text-to-speech/clone-1');
  const fixedPcm = await stream(first, {
    text: '안녕하세요',
    settings: { model: 'eleven_flash_v2_5', speed: 1.2, stability: 0.3, similarityBoost: 0.4 },
  });
  assert.equal(fixedPcm.status, 200);
  finishPcm();
  assert.deepEqual(new Uint8Array(await fixedPcm.arrayBuffer()), Uint8Array.of(1, 2, 3, 4));

  assert.equal((await fetch(base, { method: 'DELETE', headers: auth(first) })).status, 204);
  assert.deepEqual(deleted, ['/v1/voices/clone-1']);
  assert.equal(await status(first), 'NOT_REGISTERED');
  assert.equal(await status(second), 'READY');
  console.log(
    'Kick account voice, MP3, and progressive PCM integration passed (ElevenLabs mocked)',
  );
} finally {
  await app.close();
  globalThis.fetch = nativeFetch;
}
