import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test('transcribes Korean audio from the microphone with local Whisper', async ({ playwright, baseURL }) => {
  const wav = process.env.WHISPER_TEST_WAV;
  test.skip(!wav, 'Set WHISPER_TEST_WAV to a Korean WAV fixture.');
  test.setTimeout(120_000);
  const browser = await playwright.chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${resolve(wav!)}%noloop`],
  });
  try {
    const context = await browser.newContext({ baseURL, permissions: ['microphone'] });
    const page = await context.newPage();
    context.on('requestfailed', (request) => console.log('Whisper request failed:', request.url(), request.failure()?.errorText));
    await page.route('**/*', (route) => new URL(route.request().url()).origin === baseURL
      ? route.continue() : route.abort());
    await page.goto('/');
    await page.getByRole('button', { name: '음성 인식 모델 준비' }).click();
    const start = page.getByRole('button', { name: '마이크 시작' });
    const alert = page.getByRole('alert');
    await expect(start.or(alert)).toBeVisible({ timeout: 60_000 });
    if (await alert.isVisible()) throw new Error((await alert.textContent()) ?? 'Whisper failed to start');
    const modelPath = process.env.GEMMA_MODEL_PATH;
    if (modelPath) {
      await page.getByLabel('모델 파일 선택').setInputFiles(modelPath);
      await page.getByRole('button', { name: '모델 로드' }).click();
      await expect(page.getByRole('button', { name: '모델 해제' })).toBeEnabled({ timeout: 60_000 });
    }
    await start.click();
    const transcript = page.getByRole('list', { name: '확정 자막' });
    const meeting = transcript.getByRole('listitem').filter({ hasText: /금요일|회의/ }).first();
    await expect(meeting.or(alert)).toBeVisible({ timeout: 45_000 });
    if (await alert.isVisible()) throw new Error((await alert.textContent()) ?? 'Whisper failed to transcribe');
    console.log('Whisper microphone transcript:', await transcript.innerText());
    await page.getByRole('button', { name: '마이크 중지' }).click();
    await expect(start).toBeEnabled();
    if (modelPath) {
      const replies = page.getByRole('group', { name: '추천 답변' }).getByRole('button');
      await expect(replies).toHaveCount(3, { timeout: 25_000 });
      await expect(replies.filter({ hasText: /금요일|3\s*시|세\s*시/ }).first()).toBeVisible();
      console.log('Whisper-to-Gemma replies:', await replies.allTextContents());
    }
  } finally {
    await browser.close();
  }
});

test('keeps model actions disabled when WebGPU is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'gpu', { value: undefined });
  });
  await page.goto('/');
  await expect(page.getByText('이 브라우저에서 WebGPU를 사용할 수 없어요.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '모델 로드' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '응답 생성' })).toBeDisabled();
});

test('generates a Korean response from the real local model without external requests', async ({ page, baseURL }) => {
  const modelPath = process.env.GEMMA_MODEL_PATH;
  test.skip(!modelPath, 'Set GEMMA_MODEL_PATH to the downloaded model file.');
  test.setTimeout(300_000);

  await page.addInitScript(() => {
    class TestRecognition {
      processLocally = false;
      lang = '';
      onstart?: () => void;
      onresult?: (event: unknown) => void;
      onend?: () => void;
      static async available() { return 'available'; }
      static async install() { return true; }
      start() {
        if (!this.processLocally || this.lang !== 'ko-KR') throw new Error('Expected local Korean recognition');
        this.onstart?.();
        document.addEventListener('test-speech', (event) => {
          this.onresult?.((event as CustomEvent).detail);
        });
      }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.defineProperty(TestRecognition.prototype, 'processLocally', { value: false, writable: true });
    Object.defineProperty(window, 'SpeechRecognition', { value: TestRecognition });
  });

  const externalRequests: string[] = [];
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.goto('/');
  const load = page.getByRole('button', { name: '모델 로드' });
  await expect(load, 'WebGPU adapter required').toBeEnabled({ timeout: 15_000 });
  await page.getByLabel('모델 파일 선택').setInputFiles(modelPath!);
  await load.click();
  const generate = page.getByRole('button', { name: '응답 생성' });
  const alert = page.getByRole('alert');
  await expect.poll(async () => {
    if (await alert.isVisible()) return await alert.textContent();
    return (await generate.isEnabled()) ? 'ready' : 'loading';
  }, { timeout: 180_000 }).toBe('ready');
  await generate.click();
  await expect(page.getByText('생성 완료', { exact: true })).toBeVisible({ timeout: 90_000 });
  const response = page.getByLabel('모델 응답');
  await expect(response).toContainText(/[가-힣]/);
  console.log('Gemma response:', await response.textContent());
  console.log('Gemma timings:', await page.locator('.metrics dl').innerText());

  await page.getByLabel('프롬프트', { exact: true }).fill('한국어로 긴 동화를 써 주세요.');
  await generate.click();
  await page.getByRole('button', { name: '생성 중지' }).click();
  await expect(page.getByText('생성 중지됨', { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('프롬프트', { exact: true }).fill('한국어로 짧게 인사해 주세요.');
  const systemPrompt = page.getByLabel('시스템 프롬프트');
  await systemPrompt.fill('답변에 반드시 "보라색 우산"이라는 문구를 넣어 주세요.');
  await generate.click();
  await expect(page.getByText('생성 완료', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(response).toBeVisible();
  await expect(response).toContainText('보라색 우산');
  await systemPrompt.fill('');

  await page.getByLabel('음성 인식 방식').selectOption('browser');
  await page.getByRole('button', { name: '마이크 시작' }).click();
  const emitSpeech = (lines: { text: string; final: boolean }[], resultIndex = 0) => page.evaluate(
    ({ lines, resultIndex }) => document.dispatchEvent(new CustomEvent('test-speech', {
      detail: { resultIndex, results: lines.map(({ text, final }) => ({ isFinal: final, 0: { transcript: text } })) },
    })),
    { lines, resultIndex },
  );
  await emitSpeech([{ text: '금요일 오후', final: false }]);
  await expect(page.getByText('임시 자막 · 금요일 오후')).toBeVisible();
  const first = { text: '금요일 오후 2시에 회의 가능하세요?', final: true };
  const replies = page.getByRole('group', { name: '추천 답변' }).getByRole('button');
  const firstTurnStart = performance.now();
  await emitSpeech([first]);
  await expect(replies).toHaveCount(3, { timeout: 45_000 });
  console.log('First call turn to reply (ms):', Math.round(performance.now() - firstTurnStart));
  await expect(replies.filter({ hasText: /금요일|2\s*시|두\s*시/ }).first()).toBeVisible();
  const secondTurnStart = performance.now();
  await emitSpeech([first, { text: '죄송합니다. 오후 3시로 바꿔도 될까요?', final: true }], 1);
  await expect(page.getByRole('list', { name: '확정 자막' }).getByRole('listitem')).toHaveCount(2);
  await expect(replies).toHaveCount(0);
  await expect(replies).toHaveCount(3, { timeout: 45_000 });
  console.log('Second call turn to reply (ms):', Math.round(performance.now() - secondTurnStart));
  await expect(replies.filter({ hasText: /3\s*시|세\s*시/ }).filter({ hasText: '금요일' }).first()).toBeVisible();
  console.log('Call replies:', await replies.allTextContents());
  const selectedReply = await replies.nth(1).innerText();
  await replies.nth(1).click();
  await expect(page.getByRole('list', { name: '확정 자막' }).getByRole('listitem').last()).toContainText(selectedReply);
  await page.getByRole('button', { name: '대화 초기화' }).click();
  await expect(page.getByRole('list', { name: '확정 자막' }).getByRole('listitem')).toHaveCount(0);
  await expect(replies).toHaveCount(0);
  await page.getByRole('button', { name: '모델 해제' }).click();
  await expect(load).toBeEnabled();
  expect(externalRequests).toEqual([]);
});

test('downloads and reuses the browser model cache', async ({ playwright, baseURL }, testInfo) => {
  const liveDownload = process.env.GEMMA_TEST_DOWNLOAD === '1';
  const localModel = 'gemma-4-E2B-it-gpu.litertlm';
  test.skip(!liveDownload && !existsSync(localModel), 'Place the model in kick/ai or set GEMMA_TEST_DOWNLOAD=1.');
  test.setTimeout(420_000);

  // Use a normal profile so Chrome applies the same disk quota as it does for users.
  const context = await playwright.chromium.launchPersistentContext(testInfo.outputPath('chrome'), {
    channel: 'chrome',
    baseURL,
  });
  try {
    await verifyModelCache(context.pages()[0], baseURL, localModel, liveDownload);
  } finally {
    await context.close();
  }
});

async function verifyModelCache(
  page: import('@playwright/test').Page, baseURL: string | undefined, localModel: string, liveDownload: boolean,
) {
  if (!liveDownload) {
    // Exercise the browser download and storage path with the real file served
    // by Vite, independently of Hugging Face network speed.
    await page.addInitScript((file) => {
      const fetchFile = window.fetch.bind(window);
      window.fetch = (input, init) => fetchFile(
        typeof input === 'string' && input.startsWith('https://huggingface.co/') ? `/${file}` : input,
        init,
      );
    }, localModel);
  }
  await page.goto('/');
  const load = page.getByRole('button', { name: '모델 로드' });
  const generate = page.getByRole('button', { name: '응답 생성' });
  const alert = page.getByRole('alert');
  await expect(load).toBeEnabled({ timeout: 15_000 });
  await load.click();
  await expect.poll(async () => await alert.isVisible() || await generate.isEnabled(),
    { timeout: 320_000 }).toBe(true);
  if (await alert.isVisible()) throw new Error((await alert.textContent()) ?? 'Model download failed');
  await expect(page.getByText('다운로드', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '모델 해제' }).click();
  await expect(load).toBeEnabled();

  const externalRequests: string[] = [];
  let modelRequestedAgain = false;
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).pathname === `/${localModel}`) {
      modelRequestedAgain = true;
      return route.abort();
    }
    if (new URL(route.request().url()).origin === baseURL) return route.continue();
    externalRequests.push(route.request().url());
    return route.abort();
  });
  await page.reload();
  await expect(load).toBeEnabled({ timeout: 15_000 });
  await load.click();
  await expect(generate).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByText('브라우저 저장소', { exact: true })).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(modelRequestedAgain).toBe(false);
}
