import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { AiCapabilities, PersonaSettings, TURN_WAIT_LEVELS } from './ai-settings.types';

export function readCapabilities(value: unknown): AiCapabilities {
  const object = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === 'object' && !Array.isArray(input);
  if (
    !object(value) ||
    !Array.isArray(value.voices) ||
    !object(value.speakingRate) ||
    !Array.isArray(value.turnWaitLevels)
  )
    throw new Error('Invalid AI capabilities');
  const { voices, speakingRate, turnWaitLevels } = value;
  if (
    voices.length > 100 ||
    voices.some(
      (voice) =>
        !object(voice) ||
        typeof voice.id !== 'string' ||
        !/\S/.test(voice.id) ||
        typeof voice.label !== 'string' ||
        !/\S/.test(voice.label),
    )
  )
    throw new Error('Invalid AI voices');
  if (new Set(voices.map((voice: { id: string }) => voice.id)).size !== voices.length)
    throw new Error('Duplicate AI voices');
  const { min, max } = speakingRate;
  if (
    !(min === null && max === null) &&
    !(
      typeof min === 'number' &&
      Number.isFinite(min) &&
      min > 0 &&
      typeof max === 'number' &&
      Number.isFinite(max) &&
      max >= min
    )
  )
    throw new Error('Invalid AI rate range');
  if (
    turnWaitLevels.length === 0 ||
    turnWaitLevels.length > 3 ||
    new Set(turnWaitLevels).size !== turnWaitLevels.length ||
    turnWaitLevels.some((level) => !TURN_WAIT_LEVELS.includes(level))
  )
    throw new Error('Invalid AI turn wait levels');
  return {
    voices: voices.map((voice: { id: string; label: string }) => ({
      id: voice.id,
      label: voice.label,
    })),
    speakingRate: { min, max } as AiCapabilities['speakingRate'],
    turnWaitLevels,
  };
}

export function validatePersonaOptions(
  settings: Pick<PersonaSettings, 'voiceId' | 'speakingRate' | 'turnWaitLevel'>,
  options: AiCapabilities,
): void {
  const invalid: string[] = [];
  if (settings.voiceId !== null && !options.voices.some((voice) => voice.id === settings.voiceId))
    invalid.push('voiceId');
  if (
    settings.speakingRate !== null &&
    (options.speakingRate.min === null ||
      options.speakingRate.max === null ||
      settings.speakingRate < options.speakingRate.min ||
      settings.speakingRate > options.speakingRate.max)
  )
    invalid.push('speakingRate');
  if (!options.turnWaitLevels.includes(settings.turnWaitLevel)) invalid.push('turnWaitLevel');
  if (invalid.length)
    throw new ApiException(
      422,
      'BUSINESS_RULE_VIOLATION',
      'AI가 지원하지 않는 설정입니다.',
      invalid.map((field) => ({ field, reason: 'unsupported' })),
    );
}

@Injectable()
export class AiPersonaClient {
  private pendingOptions?: { key: string; promise: Promise<AiCapabilities> };
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async sharedOptions(): Promise<AiCapabilities> {
    const key = JSON.stringify([
      this.config.get('AI_AGENT_URL', { infer: true }),
      this.config.get('AI_PERSONA_TOKEN', { infer: true }),
    ]);
    if (!this.pendingOptions || this.pendingOptions.key !== key) {
      const promise = this.options().finally(() => {
        if (this.pendingOptions?.promise === promise) this.pendingOptions = undefined;
      });
      this.pendingOptions = { key, promise };
    }
    return structuredClone(await this.pendingOptions.promise);
  }

  async options(): Promise<AiCapabilities> {
    const response = await this.request('/internal/persona/options');
    try {
      if (response.status !== 200 || !response.body) throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 32768) throw new Error();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      return readCapabilities(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch {
      await response.body?.cancel().catch(() => undefined);
      throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', 'AI 지원 옵션을 확인할 수 없습니다.');
    }
  }

  async notify(aiPersonaVersionSeq: number, applicationId: string): Promise<void> {
    const response = await this.request('/internal/persona/refresh', {
      aiPersonaVersionSeq,
      applicationId,
    });
    await response.body?.cancel();
    if (response.status !== 202)
      throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', 'AI 설정 알림을 전달하지 못했습니다.');
  }

  private async request(path: string, body?: unknown): Promise<Response> {
    const token = this.config.get('AI_PERSONA_TOKEN', { infer: true });
    if (!token)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'AI 페르소나 연동이 설정되지 않았습니다.',
      );
    try {
      return await fetch(this.config.get('AI_AGENT_URL', { infer: true }) + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        'AI 페르소나 서버에 연결할 수 없습니다.',
      );
    }
  }
}
