import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../../config/environment';
import { AskModel, EFFORT, MODEL, Usage } from './complaint-judge';

const URL = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = 120_000; // 한 판 기다리는 시간(재시도 포함). 긴 통화의 한 판이 60초를 넘음 → 120 (백그라운드라 길어도 됨)
const RETRIES = 2; // 429 · 5xx · 연결 오류만 (OpenAI SDK 기본과 같음)

/** 불만 판정용 OpenAI Responses 호출 — 전용 키, 구조화 출력(json_schema strict), 요청을 저장하지 않음(store=false).
 *  대본은 개인정보라 오류 · 로그에 본문을 남기지 않는다 */
@Injectable()
export class ComplaintModelClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  enabled(): boolean {
    return !!this.config.get('CALL_ANALYSIS_OPENAI_API_KEY', { infer: true });
  }

  readonly ask: AskModel = async (instructions, input, name, schema) => {
    const key = this.config.get('CALL_ANALYSIS_OPENAI_API_KEY', {
      infer: true,
    });
    if (!key) throw new Error('call_analysis_disabled');
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const body = JSON.stringify({
      model: MODEL,
      instructions,
      input,
      reasoning: { effort: EFFORT },
      text: { format: { type: 'json_schema', name, strict: true, schema } },
      store: false,
    });
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(URL, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${key}`,
            'content-type': 'application/json',
          },
          body,
          signal,
        });
      } catch (error: unknown) {
        if (signal.aborted || attempt >= RETRIES) throw error;
        await wait(500 * 2 ** attempt, signal);
        continue;
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < RETRIES
      ) {
        await response.body?.cancel();
        await wait(500 * 2 ** attempt, signal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`call_analysis_model_http_${response.status}`);
      }
      return parse(await response.json());
    }
  };
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });
}

type ResponsesBody = {
  status?: string;
  output?: { type?: string; content?: { type?: string; text?: string }[] }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
};

/** 응답 → (결과 JSON, 토큰). SDK의 output_text처럼 메시지의 output_text 조각을 이어 붙인다 */
export function parse(raw: unknown): { data: unknown; usage: Usage | null } {
  const body = (raw ?? {}) as ResponsesBody;
  const text = (body.output ?? [])
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter(
      (part) => part.type === 'output_text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
  if (!text) throw new Error('call_analysis_model_empty');
  const u = body.usage;
  return {
    data: JSON.parse(text),
    usage: u
      ? {
          input: u.input_tokens ?? null,
          cached: u.input_tokens_details?.cached_tokens ?? null,
          output: u.output_tokens ?? null,
          reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
        }
      : null,
  };
}
