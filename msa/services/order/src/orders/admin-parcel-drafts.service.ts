import type { DraftWriteEvent } from '@dva/events/parcel-draft-write.cjs';
import { SubmitAdminParcelDraftDto } from './dto/admin-parcel-draft.dto';
import { ParcelDraftWritesRepository } from './parcel-draft-writes.repository';
import { ParcelDraftWriteScope } from './parcel-draft-write-scope.service';
import { OrdersRepository } from './orders.repository';
import { OrderSubmissionService } from './order-submission.service';
import { orderDraft } from './order-draft';
import { createValidationPipe } from '../common/http/validation.pipe';
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
    private readonly writes: ParcelDraftWritesRepository,
    private readonly orders: OrdersRepository,
    private readonly submissions: OrderSubmissionService,
    private readonly scope: ParcelDraftWriteScope,
  ) {}

  async submit(id: number, input: SubmitAdminParcelDraftDto, adminId: number, requestId: string) {
    const saved = await this.scope.request({
      operation: 'AdminParcelDraftSubmitted',
      id,
      adminId,
      callSessionSeq: null,
      input: { ...input },
      requestId,
    });
    const orderSeq = saved.orderSeq as number;
    await this.submissions.submitPaidOrder(orderSeq, requestId);
    return {
      ...saved,
      ...(await this.database.transaction((client) => this.orders.result(client, orderSeq, null))),
    };
  }
  executeSubmit(event: DraftWriteEvent) {
    return this.scope.run(event, async () => {
      const command = event.payload.command;
      const input = (await createValidationPipe().transform(command.input, {
        type: 'body',
        metatype: SubmitAdminParcelDraftDto,
      })) as SubmitAdminParcelDraftDto;
      return this.submitLocal(command.id!, input, command.adminId!, command.requestId);
    });
  }
  private async submitLocal(
    id: number,
    input: SubmitAdminParcelDraftDto,
    adminId: number,
    requestId: string,
  ) {
    const saved = await this.scope.transaction(async (client) => {
      const hint = await this.writes.draft(client, id);
      if (!hint) throw new ApiException(404, 'NOT_FOUND', '배송 초안을 찾을 수 없습니다.');
      if (hint.callSessionSeq !== null)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '미완료 배송을 새 관리자 단독 초안으로 재개한 후 접수해 주세요.',
        );
      await this.writes.lockScope(client, hint.customerSeq, hint.callerPhoneNumber);
      if (hint.customerSeq === null || !(await this.writes.customer(client, hint.customerSeq)))
        throw new ApiException(404, 'NOT_FOUND', '활성 고객이 필요합니다.');
      const row = await this.writes.draft(client, id, true);
      if (!row) throw new ApiException(404, 'NOT_FOUND', '배송 초안을 찾을 수 없습니다.');
      if (row.status === 'CONVERTED') {
        const result = await this.orders.result(client, row.orderSeq!, null);
        if (!result)
          throw new ApiException(
            409,
            'INVALID_STATE',
            '이미 접수된 초안입니다. 원본 주문은 삭제되었거나 만료되었습니다.',
          );
        return { ...result, draftSeq: id, orderParcelSeq: row.orderParcelSeq! };
      }
      if (row.status !== 'READY')
        throw new ApiException(409, 'INVALID_STATE', 'READY 초안만 최종 접수할 수 있습니다.');
      if (row.version !== input.expectedVersion)
        throw new ApiException(409, 'VERSION_CONFLICT', '최신 초안 내용을 다시 확인해 주세요.');
      const draft = orderDraft({
        ...input,
        parcels: [row.parcel],
        totalAmount: row.parcel.notifiedPrice,
      });
      const created = await this.orders.insert(
        client,
        draft,
        row.customerSeq,
        randomUUID(),
        'ADMIN',
        adminId,
        row.reservedOrderSeq,
      );
      await this.submissions.prepareSubmission(
        client,
        created.orderSeq,
        row.customerSeq!,
        adminId,
        requestId,
      );
      const parcel = (await this.orders.parcelReferences(client, created.orderSeq))[0];
      await client.query(
        `UPDATE order_parcel_drafts SET status='CONVERTED',order_seq=$2,order_parcel_seq=$3,version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1`,
        [id, created.orderSeq, parcel.orderParcelSeq],
      );
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: created.orderSeq,
          targetType: 'ORDER',
          action: 'ORDER_CREATED',
          requestId,
        },
        client,
      );
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: id,
          targetType: 'ORDER_PARCEL_DRAFT',
          action: 'PARCEL_DRAFT_CONVERTED',
          requestId,
        },
        client,
      );
      return {
        ...(await this.orders.result(client, created.orderSeq, null)),
        draftSeq: id,
        orderParcelSeq: parcel.orderParcelSeq,
      };
    });
    return saved;
  }

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
