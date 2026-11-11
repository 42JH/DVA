import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ApiException } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';

@Injectable()
export class OrderDeletionCheckClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  blocked(orderSeq: number): Promise<boolean> {
    return this.query(orderSeq, 'OrderDeletionCheckRequested');
  }

  async submissionAllowed(orderSeq: number): Promise<boolean> {
    return !(await this.query(orderSeq, 'OrderSubmissionCheckRequested'));
  }

  private async query(orderSeq: number, eventType: string): Promise<boolean> {
    const eventId = randomUUID();
    try {
      const response = await fetch(
        this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/order-deletion-check',
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
          headers: {
            Authorization: 'Bearer ' + this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventId,
            source: 'order',
            eventType,
            payload: { orderSeq },
          }),
        },
      );
      try {
        if (
          response.status !== 200 ||
          !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')
        )
          throw new Error('Invalid order call check response');
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const part of response.body ?? []) {
          size += part.length;
          if (size > 4096) throw new Error('Invalid deletion check response');
          parts.push(part);
        }
        const result: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)),
        );
        if (
          !result ||
          typeof result !== 'object' ||
          Object.keys(result).sort().join(',') !== 'eventId,payload,status' ||
          !('eventId' in result) ||
          result.eventId !== eventId ||
          !('status' in result) ||
          result.status !== 'processed' ||
          !('payload' in result) ||
          !result.payload ||
          typeof result.payload !== 'object' ||
          Object.keys(result.payload).join(',') !== 'blocked' ||
          !('blocked' in result.payload) ||
          typeof result.payload.blocked !== 'boolean'
        )
          throw new Error('Invalid deletion check acknowledgement');
        return result.payload.blocked;
      } finally {
        await response.body?.cancel();
      }
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }
}
