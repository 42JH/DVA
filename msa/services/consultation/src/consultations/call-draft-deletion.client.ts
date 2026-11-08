import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { requestParcelDraftCommand } from '@dva/events/parcel-drafts.cjs';
import { ApiException } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';

@Injectable()
export class CallDraftDeletionClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}
  async blocked(callSessionSeq: number): Promise<boolean> {
    try {
      return await requestParcelDraftCommand(
        this.config.get('ORDER_URL', { infer: true }) +
          '/internal/call-draft-deletion-check',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'consultation',
          eventType: 'CallDraftDeletionCheckRequested',
          payload: { callSessionSeq },
        },
      );
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }
}
