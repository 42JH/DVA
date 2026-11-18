import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { createHash } from 'node:crypto';

export async function responseText(response: Response) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body!.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) {
      await reader.cancel();
      throw new Error('Response too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
@Injectable()
export class PaymentClient {
  timeout = 10000;
  constructor(private readonly config: ConfigService<Environment, true>) {}
  async toss(id: string, amount: number, key: string, lookupOnly: boolean) {
    try {
      const response = await fetch(
        this.config.get('PAYMENT_TOSS_BASE_URL', { infer: true }) +
          (lookupOnly ? '/v1/payments/' + encodeURIComponent(key) : '/v1/payments/confirm'),
        {
          method: lookupOnly ? 'GET' : 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeout),
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(this.config.get('TOSS_TEST_SECRET_KEY', { infer: true }) + ':').toString(
                'base64',
              ),
            ...(!lookupOnly
              ? {
                  'Content-Type': 'application/json',
                  'Idempotency-Key': createHash('sha256')
                    .update(JSON.stringify([id, amount, key]))
                    .digest('hex'),
                }
              : {}),
          },
          ...(!lookupOnly
            ? { body: JSON.stringify({ orderId: id, amount, paymentKey: key }) }
            : {}),
        },
      );
      const value: unknown = JSON.parse(await responseText(response));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return { status: response.status, data: value as Record<string, unknown> };
    } catch {
      throw new ApiException(502, 'PAYMENT_RESULT_UNKNOWN', '결제 결과를 조회로 확인해 주세요.');
    }
  }
  async notify(text: string): Promise<'SENT' | 'FAILED' | 'UNKNOWN'> {
    try {
      const response = await fetch(
        this.config.get('PAYMENT_MATTERMOST_WEBHOOK_URL', { infer: true })!,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeout),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        },
      );
      const body = await responseText(response);
      if (response.status === 200 && body.trim() === 'ok') return 'SENT';
      return response.status >= 400 && response.status < 500 ? 'FAILED' : 'UNKNOWN';
    } catch {
      return 'UNKNOWN';
    }
  }
}
