import { env, pipeline } from '@huggingface/transformers';

const model = 'Xenova/whisper-base';
const revision = '6e0b7661dae4c3b55a0781ab5f021ddd673d57b8';

let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<{ base: string; samples?: Float32Array }>) => {
  queue = queue.then(() => recognizeMessage(data));
};

async function recognizeMessage(data: { base: string; samples?: Float32Array }) {
  try {
    if (!transcriber) {
      const localModel = new URL(`models/${model}/`, data.base);
      const localConfig = await fetch(new URL('config.json', localModel));
      const localAvailable = localConfig.ok && localConfig.headers.get('content-type')?.includes('application/json');
      const onnx = new URL('onnx/', data.base);
      env.backends.onnx.wasm!.wasmPaths = {
        mjs: new URL('ort-wasm-simd-threaded.asyncify.mjs', onnx).href,
        wasm: new URL('ort-wasm-simd-threaded.asyncify.wasm', onnx).href,
      };
      env.backends.onnx.wasm!.numThreads = 1;
      if (localAvailable) {
        env.remoteHost = new URL('models/', data.base).href;
        env.remotePathTemplate = '{model}/';
      }
      transcriber = createTranscriber();
    }
    const recognize = await transcriber;
    if (!data.samples) {
      self.postMessage({ ready: true });
      return;
    }
    const output = await recognize(data.samples, {
      language: 'korean', task: 'transcribe', max_new_tokens: 96,
    });
    self.postMessage({ text: (Array.isArray(output) ? output[0]?.text : output.text)?.trim() ?? '' });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}

function createTranscriber() {
  return pipeline('automatic-speech-recognition', model, { device: 'wasm', dtype: 'q8', revision });
}

let transcriber: ReturnType<typeof createTranscriber> | undefined;
