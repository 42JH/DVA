import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { SubmitAdminParcelDraftDto } from './dto/admin-parcel-draft.dto';
import { orderDraft } from './order-draft';
import { OrderSubmissionService } from './order-submission.service';
import { OrdersRepository } from './orders.repository';
import { ParcelDraftsRepository } from './parcel-drafts.repository';
import { writeOrder } from './order-write';

@Injectable()
export class AdminParcelDraftsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly drafts: ParcelDraftsRepository,
    private readonly orders: OrdersRepository,
    private readonly submissions: OrderSubmissionService,
    private readonly audit: AuditService,
  ) {}

  async submit(id: number, input: SubmitAdminParcelDraftDto, adminId: number, requestId: string) {
    const saved = await writeOrder(this.database, async (client) => {
      const hint = await this.drafts.draft(client, id);
      if (!hint) throw new ApiException(404, 'NOT_FOUND', '배송 초안을 찾을 수 없습니다.');
      if (hint.callSessionSeq !== null)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '미완료 배송을 새 관리자 단독 초안으로 재개한 후 접수해 주세요.',
        );
      await this.drafts.lockScope(client, hint.customerSeq, hint.callerPhoneNumber);
      if (hint.customerSeq === null || !(await this.drafts.customer(client, hint.customerSeq)))
        throw new ApiException(404, 'NOT_FOUND', '활성 고객이 필요합니다.');
      const row = await this.drafts.draft(client, id, true);
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
    // Existing payment/submission state serializes concurrent retries after this commit.
    await this.submissions.submitPaidOrder(saved.orderSeq, requestId);
    return {
      ...saved,
      ...(await this.database.transaction((client) =>
        this.orders.result(client, saved.orderSeq, null),
      )),
    };
  }

  async delete(id: number, adminId: number, requestId: string): Promise<void> {
    await writeOrder(this.database, async (client) => {
      const hint = await this.drafts.draft(client, id);
      if (!hint) throw new ApiException(404, 'NOT_FOUND', '배송 초안을 찾을 수 없습니다.');
      const call =
        hint.callSessionSeq === null
          ? undefined
          : await this.drafts.call(client, hint.callSessionSeq);
      const row = await this.drafts.draft(client, id, true);
      if (!row) throw new ApiException(404, 'NOT_FOUND', '배송 초안을 찾을 수 없습니다.');
      if (call && !call.finalizedAt && ['READY', 'EDITING'].includes(row.status))
        throw new ApiException(
          409,
          'INVALID_STATE',
          '통화 주문 확정 전에는 초안을 삭제할 수 없습니다.',
        );
      await client.query(
        'UPDATE order_parcel_drafts SET deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1',
        [id],
      );
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          targetId: id,
          targetType: 'ORDER_PARCEL_DRAFT',
          action: 'PARCEL_DRAFT_DELETED',
          requestId,
        },
        client,
      );
    });
  }
}
