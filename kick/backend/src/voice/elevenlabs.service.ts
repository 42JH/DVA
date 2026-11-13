import { BadGatewayException, Injectable, ServiceUnavailableException } from '@nestjs/common';

const origin = 'https://api.elevenlabs.io';
const maxSpeechBytes = 1024 * 1024;

export type VoiceSample = { buffer: Buffer; mimetype: 'audio/mpeg' | 'audio/wav' };
export type SpeechSettings = {
  model?: 'eleven_flash_v2_5' | 'eleven_multilingual_v2';
  speed?: number;
  stability?: number;
  similarityBoost?: number;
  style?: number;
};

const fixedSpeechSettings: SpeechSettings = {
  model: 'eleven_multilingual_v2',
  speed: 0.92,
  stability: 0.75,
  similarityBoost: 0.9,
  style: 0.05,
};

export class ElevenLabsRequestError extends BadGatewayException {
  constructor(
    readonly upstreamStatus?: number,
    readonly requiresPaidPlan = false,
  ) {
    super('ElevenLabs could not complete the request');
  }
}

@Injectable()
export class ElevenLabsService {
  private readonly apiKey = process.env.ELEVENLABS_API_KEY?.trim();

  requireApiKey(): string {
    if (!this.apiKey) {
      throw new ServiceUnavailableException('ElevenLabs is not configured');
    }
    return this.apiKey;
  }

  private async request(path: string, init: RequestInit, allowNotFound = false): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('xi-api-key', this.requireApiKey());
    let response: Response;
    const timeout = AbortSignal.timeout(45_000);
    try {
      response = await fetch(origin + path, {
        ...init,
        headers,
        redirect: 'error',
        signal: init.signal ? AbortSignal.any([timeout, init.signal]) : timeout,
      });
    } catch {
      throw new ElevenLabsRequestError();
    }
    if (!response.ok && !(allowNotFound && response.status === 404)) {
      let requiresPaidPlan = false;
      if (path === '/v1/voices/add' && [400, 402, 403].includes(response.status)) {
        const error: unknown = await response.json().catch(() => null);
        if (typeof error === 'object' && error !== null && 'detail' in error) {
          const detail = error.detail;
          requiresPaidPlan =
            typeof detail === 'object' &&
            detail !== null &&
            (('code' in detail && detail.code === 'paid_plan_required') ||
              ('status' in detail && detail.status === 'can_not_use_instant_voice_cloning'));
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      throw new ElevenLabsRequestError(response.status, requiresPaidPlan);
    }
    return response;
  }

  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ElevenLabsRequestError();
    }
  }

  async clone(accountId: string, sample: VoiceSample) {
    const form = new FormData();
    form.set('name', `Kick ${accountId}`);
    const extension = sample.mimetype === 'audio/mpeg' ? 'mp3' : 'wav';
    form.append(
      'files',
      new Blob([new Uint8Array(sample.buffer)], { type: sample.mimetype }),
      `sample.${extension}`,
    );
    const data = await this.json(
      await this.request('/v1/voices/add', { method: 'POST', body: form }),
    );
    if (
      typeof data !== 'object' ||
      data === null ||
      !('voice_id' in data) ||
      typeof data.voice_id !== 'string' ||
      !/^[a-z0-9_-]{1,128}$/i.test(data.voice_id) ||
      !('requires_verification' in data) ||
      typeof data.requires_verification !== 'boolean'
    ) {
      throw new ElevenLabsRequestError();
    }
    return { voiceId: data.voice_id, requiresVerification: data.requires_verification };
  }

  async isVerified(voiceId: string): Promise<boolean> {
    const data = await this.json(
      await this.request(`/v1/voices/${encodeURIComponent(voiceId)}`, { method: 'GET' }),
    );
    if (
      typeof data !== 'object' ||
      data === null ||
      !('voice_id' in data) ||
      data.voice_id !== voiceId
    ) {
      throw new ElevenLabsRequestError();
    }
    const verification = 'voice_verification' in data ? data.voice_verification : null;
    return (
      typeof verification === 'object' &&
      verification !== null &&
      'is_verified' in verification &&
      verification.is_verified === true
    );
  }

  private speechBody(text: string, requestedSettings?: SpeechSettings): string {
    const settings =
      process.env.KICK_TTS_FIXED_SETTINGS === 'true' ? fixedSpeechSettings : requestedSettings;
    return JSON.stringify({
      text,
      model_id: settings?.model ?? 'eleven_flash_v2_5',
      voice_settings: settings && {
        speed: settings.speed,
        stability: settings.stability,
        similarity_boost: settings.similarityBoost,
        style: settings.style,
      },
    });
  }

  async speech(voiceId: string, text: string): Promise<Buffer> {
    const response = await this.request(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: this.speechBody(text),
      },
    );
    if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'audio/mpeg') {
      await response.body?.cancel().catch(() => undefined);
      throw new ElevenLabsRequestError();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > maxSpeechBytes) {
          throw new ElevenLabsRequestError();
        }
        chunks.push(value);
      }
    } catch {
      await reader.cancel().catch(() => undefined);
      throw new ElevenLabsRequestError();
    } finally {
      reader.releaseLock();
    }
    if (bytes === 0) {
      throw new ElevenLabsRequestError();
    }
    return Buffer.concat(chunks, bytes);
  }

  async streamSpeech(
    voiceId: string,
    text: string,
    signal: AbortSignal,
    settings?: SpeechSettings,
  ) {
    const response = await this.request(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream?output_format=pcm_16000`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'audio/pcm' },
        body: this.speechBody(text, settings),
        signal,
      },
    );
    if (!response.body || response.headers.get('content-type')?.split(';')[0] !== 'audio/pcm') {
      await response.body?.cancel().catch(() => undefined);
      throw new ElevenLabsRequestError();
    }

    const chunks = response.body;
    return (async function* () {
      let bytes = 0;
      try {
        for await (const chunk of chunks) {
          if (chunk.byteLength === 0) {
            continue;
          }
          bytes += chunk.byteLength;
          if (bytes > maxSpeechBytes) {
            throw new ElevenLabsRequestError();
          }
          yield chunk;
        }
      } catch {
        throw new ElevenLabsRequestError();
      }
      if (bytes === 0 || bytes % 2 !== 0) {
        throw new ElevenLabsRequestError();
      }
    })();
  }

  async delete(voiceId: string): Promise<void> {
    const response = await this.request(
      `/v1/voices/${encodeURIComponent(voiceId)}`,
      { method: 'DELETE' },
      true,
    );
    if (response.status === 404) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    const data = await this.json(response);
    if (typeof data !== 'object' || data === null || !('status' in data) || data.status !== 'ok') {
      throw new ElevenLabsRequestError();
    }
  }
}
