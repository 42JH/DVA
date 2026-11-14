import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReadableStream } from 'node:stream/web';
import { ApiException } from '../common/errors/api.exception';
import { Environment } from '../config/environment';
import { personaCheckRunId, StartPersonaCheckRunDto } from './dto/persona-check.dto';

const unavailable = () =>
  new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '페르소나 시험 창구를 사용할 수 없습니다.');

@Injectable()
export class PersonaCheckClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async json(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    input?: StartPersonaCheckRunDto,
  ): Promise<unknown> {
    const response = await this.request(path, {
      method,
      body: input ? JSON.stringify(input) : undefined,
      headers: input ? { 'Content-Type': 'application/json' } : undefined,
      signal: AbortSignal.timeout(8000),
    });
    if (response.status !== (method === 'POST' ? 202 : 200))
      return this.reject(response, method === 'GET' || input !== undefined);
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0];
    if (mediaType !== 'application/json') return this.reject(response);
    try {
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object') throw unavailable();
      if (
        method === 'POST' &&
        (!('runId' in data) ||
          typeof data.runId !== 'string' ||
          !personaCheckRunId.test(data.runId))
      )
        throw unavailable();
      return data;
    } catch {
      throw unavailable();
    }
  }

  async audio(path: string, range: string | undefined, abort: AbortController) {
    // Stop the deadline once headers arrive so large recordings can finish streaming.
    const deadline = setTimeout(() => abort.abort(), 8000);
    let response: Response;
    try {
      response = await this.request(path, {
        headers: { 'Accept-Encoding': 'identity', ...(range && { Range: range }) },
        signal: abort.signal,
      });
    } finally {
      clearTimeout(deadline);
    }
    if (response.status === 416) {
      const contentRange = response.headers.get('content-range');
      await response.body?.cancel().catch(() => undefined);
      return { contentRange };
    }
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0];
    const encoding = response.headers.get('content-encoding');
    if (
      (response.status !== 200 && response.status !== 206) ||
      !(response.body instanceof ReadableStream) ||
      (mediaType !== 'audio/wav' &&
        mediaType !== 'audio/x-wav' &&
        !(response.status === 206 && mediaType === 'multipart/byteranges')) ||
      (encoding && encoding !== 'identity')
    )
      return this.reject(response);
    return { response, body: response.body };
  }

  private async request(path: string, options: RequestInit): Promise<Response> {
    const url = this.config.get('PERSONA_CHECK_URL', { infer: true });
    const token = this.config.get('PERSONA_CHECK_TOKEN', { infer: true });
    if (!url || !token) throw unavailable();
    try {
      const headers = new Headers(options.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return await fetch(url + path, { ...options, headers, redirect: 'error' });
    } catch {
      throw unavailable();
    }
  }

  private async reject(response: Response, forwardBadRequest = true): Promise<never> {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404)
      throw new ApiException(404, 'NOT_FOUND', '요청한 시험 데이터를 찾을 수 없습니다.');
    if (forwardBadRequest && (response.status === 400 || response.status === 422))
      throw new ApiException(400, 'INVALID_REQUEST', '시험 요청 값을 확인해 주세요.');
    throw unavailable();
  }
}
