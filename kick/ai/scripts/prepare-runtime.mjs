import { cpSync, mkdirSync } from 'node:fs';

cpSync(
  new URL('../node_modules/@litert-lm/core/wasm/', import.meta.url),
  new URL('../public/litertlm/', import.meta.url),
  { recursive: true },
);

mkdirSync(new URL('../public/onnx/', import.meta.url), { recursive: true });
const onnxDist = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
for (const extension of ['mjs', 'wasm']) {
  const file = `ort-wasm-simd-threaded.asyncify.${extension}`;
  cpSync(new URL(file, onnxDist), new URL(`../public/onnx/${file}`, import.meta.url));
}
