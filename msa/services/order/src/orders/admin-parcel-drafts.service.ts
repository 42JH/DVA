import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { requestDraftDeletion, OrderReadError } from '@dva/events/order-read.cjs';
import { requestDraftCallReferences, type DraftDeletionEvent } from '@dva/events/parcel-drafts.cjs';
import { readCallbackUrl } from '@dva/events/read-scope.cjs';
import { AuditService } from '../audit/audit.service';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { ParcelDraftReadsRepository } from './parcel-draft-reads.repository';
import { writeOrder } from './order-write';

@Injectable()
export class AdminParcelDraftsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ParcelDraftReadsRepository,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
  ) {}

  async delete(id: number, adminId: number, requestId: string): Promise<void> {
    try {
      await requestDraftDeletion(
        this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/parcel-draft-delete',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'ParcelDraftDeletionRequested',
          payload: {
            command: { id, adminId, requestId },
            orderAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
          },
        },
      );
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  execute(event: DraftDeletionEvent) {
    const { command, phase, callFinalized } = event.payload;
    const readCalls = (input: { callIds: number[]; customerIds: number[]; phones: string[] }) =>
      requestDraftCallReferences(
        readCallbackUrl(
          this.config.get('CONSULTATION_URL', { infer: true }),
          '/internal/order-draft-call-references',
          event.payload.consultationAddress ?? null,
        ),
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        input,
        event.eventId,
      );
    if (phase === 'hint')
      return this.database.transaction(async (client) => {
        const row = await this.repository.draft(client, command.id, readCalls);
        return row ? { callSessionSeq: row.callSessionSeq } : null;
      });
    return writeOrder(this.database, async (client) => {
      const row = await this.repository.draft(client, command.id, readCalls, true);
      if (!row) throw new ApiException(404, 'NOT_FOUND', '배송 초안을 찾을 수 없습니다.');
      if (callFinalized === false && ['READY', 'EDITING'].includes(row.status))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '통화 주문 확정 전에는 초안을 삭제할 수 없습니다.',
        );
      await client.query(
        'UPDATE order_parcel_drafts SET deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1',
        [command.id],
      );
      await this.audit.recordSuccess(
        {
          actorId: command.adminId,
          targetId: command.id,
          targetType: 'ORDER_PARCEL_DRAFT',
          action: 'PARCEL_DRAFT_DELETED',
          requestId: command.requestId,
        },
        client,
      );
      return true as const;
    });
  }
}
