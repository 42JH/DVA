export const modelFile = 'gemma-4-E2B-it-gpu.litertlm';
export const modelRevision = 'cccc664ea93091c52eeb7867ad4e5466357e14f3';
export const modelBytes = 2_340_870_772;
export const modelUrl = `https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/${modelRevision}/${modelFile}`;

export async function getGpuAdapter() {
  if (!navigator.gpu) {
    throw new Error('이 브라우저에서 WebGPU를 사용할 수 없어요. Chrome 또는 Edge에서 localhost로 열어 주세요.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('WebGPU에서 사용할 GPU를 찾지 못했어요.');
  return adapter;
}

export async function prepareModel(
  localFile: File | undefined,
  onProgress: (bytes: number) => void,
) {
  if (localFile) {
    if (localFile.size !== modelBytes) {
      throw new Error('선택한 파일의 크기가 이 실험의 Gemma 모델과 달라요. 모델 링크에서 지정된 파일을 받아 주세요.');
    }
    return { file: localFile, source: '로컬 파일', downloadMs: null };
  }

  const root = await navigator.storage.getDirectory();
  const cacheName = `${modelRevision}-${modelFile}`;
  // The file is visible to readers only after the write stream commits.
  return navigator.locks.request(cacheName, async () => {
    const handle = await root.getFileHandle(cacheName, { create: true });
    const cached = await handle.getFile();
    if (cached.size === modelBytes) {
      return { file: cached, source: '브라우저 저장소', downloadMs: null };
    }

    const { quota, usage } = await navigator.storage.estimate();
    if (quota !== undefined && usage !== undefined && quota - usage < modelBytes) {
      throw new Error('브라우저 저장 공간이 부족해요. 모델을 직접 내려받아 파일을 선택해 주세요.');
    }

    const start = performance.now();
    const response = await fetch(modelUrl);
    if (!response.ok || !response.body) {
      throw new Error(`모델 다운로드에 실패했어요 (HTTP ${response.status}).`);
    }
    const writer = await handle.createWritable().catch(async (error: unknown) => {
      await response.body?.cancel();
      throw error;
    });
    let bytes = 0;
    let lastUpdate = 0;
    await response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > modelBytes) throw new Error('내려받은 모델의 크기가 예상보다 커요.');
        const now = performance.now();
        if (now - lastUpdate >= 200) {
          onProgress(bytes);
          lastUpdate = now;
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (bytes !== modelBytes) throw new Error('모델 파일을 끝까지 받지 못했어요.');
        onProgress(bytes);
      },
    })).pipeTo(writer).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        throw new Error('브라우저 저장 공간이 부족해요. 모델을 직접 내려받아 파일을 선택해 주세요.');
      }
      throw error;
    });

    return {
      file: await handle.getFile(),
      source: '다운로드',
      downloadMs: performance.now() - start,
    };
  });
}
