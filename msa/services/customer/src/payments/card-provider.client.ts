import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import type { RegisterPaymentCardDto } from './payment-cards.dto';

@Injectable()
export class CardProviderClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  private async request(path: string, key: string, body?: object, method?: string) {
    const secret = this.config.get('TOSS_BILLING_SECRET_KEY', { infer: true });
    if (!secret)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '카드 자동결제 연동이 설정되지 않았습니다.',
      );
    try {
      const response = await fetch(
        this.config.get('PAYMENT_TOSS_BASE_URL', { infer: true }) + path,
        {
          method: method ?? (body ? 'POST' : 'GET'),
          redirect: 'error',
          signal: AbortSignal.timeout(65000),
          headers: {
            Authorization: 'Basic ' + Buffer.from(secret + ':').toString('base64'),
            ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const chunks: Uint8Array[] = [];
      const reader = response.body!.getReader();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          await reader.cancel();
          throw new Error('Response too large');
        }
        chunks.push(value);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      const data: unknown = text ? JSON.parse(text) : {};
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('invalid_card_response');
      return { status: response.status, data: data as Record<string, unknown> };
    } catch {
      throw new ApiException(502, 'PAYMENT_RESULT_UNKNOWN', '카드 처리 결과를 확인해 주세요.');
    }
  }

  register(customerKey: string, key: string, input: RegisterPaymentCardDto) {
    return this.request('/v1/billing/authorizations/card', key, {
      customerKey,
      cardNumber: input.cardNumber,
      cardExpirationYear: String(input.expirationYear).slice(-2),
      cardExpirationMonth: String(input.expirationMonth).padStart(2, '0'),
      customerIdentityNumber: input.customerIdentityNumber,
      ...(input.cardPassword ? { cardPassword: input.cardPassword } : {}),
      ...(input.customerName ? { customerName: input.customerName } : {}),
    });
  }

  revoke(billingKey: string) {
    return this.request('/v1/billing/' + encodeURIComponent(billingKey), '', undefined, 'DELETE');
  }
}
