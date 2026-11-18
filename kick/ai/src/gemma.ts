import { Backend, Engine, loadLiteRtLm, type Conversation } from '@litert-lm/core';

export class Gemma {
  private engine?: Engine;
  private conversation?: Conversation;
  private runtimeReady?: Promise<unknown>;
  private cancelled = false;

  async initialize(file: File) {
    this.runtimeReady ??= loadLiteRtLm(
      new URL(`${import.meta.env.BASE_URL}litertlm/`, location.origin).href,
    ).catch((error: unknown) => {
      this.runtimeReady = undefined;
      throw error;
    });
    await this.runtimeReady;
    const engine = await Engine.create({
      model: file,
      backend: Backend.GPU_ARTISAN,
      mainExecutorSettings: { maxNumTokens: 2048 },
      benchmarkEnabled: true,
    });
    if (engine.settings.backend !== Backend.GPU_ARTISAN && engine.settings.backend !== Backend.GPU) {
      await engine.delete();
      throw new Error('모델이 WebGPU 엔진으로 초기화되지 않았어요.');
    }
    this.engine = engine;
  }

  async generate(prompt: string, onText: (text: string, elapsedMs: number) => void, systemPrompt = '') {
    if (!this.engine) throw new Error('먼저 모델을 로드해 주세요.');
    this.cancelled = false;
    const conversation = await this.engine.createConversation({
      preface: {
        messages: systemPrompt.trim() ? [{ role: 'system', content: systemPrompt.trim() }] : [],
        extra_context: { enable_thinking: false },
      },
      sessionConfig: { maxOutputTokens: 160 },
    });
    this.conversation = conversation;
    let text = '';
    const start = performance.now();
    try {
      if (!this.cancelled) {
        for await (const chunk of conversation.sendMessageStreaming(prompt)) {
          if (this.cancelled) break;
          if (typeof chunk.content === 'string') {
            text += chunk.content;
          } else {
            for (const item of chunk.content ?? []) {
              if (item.type === 'text') text += item.text;
            }
          }
          if (text.trim()) onText(text, performance.now() - start);
        }
      }
      const totalMs = performance.now() - start;
      if (this.cancelled) return null;
      if (!text.trim()) throw new Error('모델이 화면에 표시할 응답을 생성하지 못했어요.');

      const benchmark = await conversation.getBenchmarkInfo().catch(() => null);
      return this.cancelled ? null : { totalMs, benchmark };
    } catch (error) {
      if (this.cancelled) return null;
      throw error;
    } finally {
      this.conversation = undefined;
      await conversation.delete();
    }
  }

  cancel() {
    this.cancelled = true;
    this.conversation?.cancel();
  }

  async release() {
    const engine = this.engine;
    this.engine = undefined;
    await engine?.delete();
  }
}
