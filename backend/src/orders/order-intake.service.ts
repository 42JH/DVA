import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { ConsultationsService } from '../consultations/consultations.service';
import { CompleteOrderIntakeDto, OrderIntakeResponseDto } from './dto/order-intake.dto';
import { orderDraft } from './order-draft';
import { OrderIntakeRepository } from './order-intake.repository';
import { OrderSubmissionService } from './order-submission.service';
import { OrdersRepository } from './orders.repository';
import { ParcelDraftsRepository } from './parcel-drafts.repository';
import { ParcelDraftsService } from './parcel-drafts.service';
import { ParcelDraftRow } from './parcel-drafts.types';
import { writeOrder } from './order-write';
import { assertOrderAmount } from './order-pricing';
import { OrderPaymentsRepository } from './order-payments.repository';

@Injectable()
export class OrderIntakeService {
  private readonly logger = new Logger(OrderIntakeService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrderIntakeRepository,
    private readonly drafts: ParcelDraftsRepository,
    private readonly access: ParcelDraftsService,
    private readonly orders: OrdersRepository,
    private readonly calls: ConsultationsService,
    private readonly submissions: OrderSubmissionService,
    private readonly audit: AuditService,
    private readonly payments: OrderPaymentsRepository,
  ) {}

  async complete(id: number, input: CompleteOrderIntakeDto, requestId: string) {
    const payload: CompleteOrderIntakeDto = {
      expectedIntakeVersion: input.expectedIntakeVersion,
      ...(input.paymentMethodType ? { paymentMethodType: input.paymentMethodType } : {}),
      pickupRequestedAt: input.pickupRequestedAt
        ? new Date(input.pickupRequestedAt).toISOString()
        : null,
    };
    await writeOrder(this.database, async (client) => {
      const call = await this.drafts.call(client, id);
      if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (!call.enabled) throw new ApiException(409, 'INVALID_STATE', '이전 계약의 통화입니다.');
      if (call.completionPayload) {
        if (!isDeepStrictEqual(call.completionPayload, payload))
          throw new ApiException(
            409,
            'EVENT_PAYLOAD_CONFLICT',
            '이미 확정한 통화 주문 완료 내용과 다릅니다.',
          );
        return;
      }
      if (call.orderSeq !== null)
        throw new ApiException(409, 'INVALID_STATE', '이미 주문이 연결된 통화입니다.');
      if (call.intakeVersion !== input.expectedIntakeVersion)
        throw new ApiException(
          409,
          'VERSION_CONFLICT',
          '마지막 초안 저장 응답의 intakeVersion을 확인해 주세요.',
        );
      const rows = await this.lockDrafts(client, id);
      if (rows.some((row) => row.status === 'READY') && !input.paymentMethodType)
        throw new ApiException(
          422,
          'VALIDATION_FAILED',
          '완성된 배송 초안에는 결제수단이 필요합니다.',
        );
      const ready = rows.filter((row) => row.status === 'READY');
      if (ready.length) {
        assertOrderAmount({
          totalAmount: ready.reduce((sum, row) => sum + (row.parcel.notifiedPrice ?? 0), 0),
          parcels: ready.map((row) => row.parcel),
        });
        if (call.customerSeq === null || !(await this.drafts.customer(client, call.customerSeq)))
          throw new ApiException(403, 'FORBIDDEN', '통화에 연결된 활성 고객이 필요합니다.');
        const policy = await this.payments.eligibility(client, call.customerSeq);
        if (
          (input.paymentMethodType === 'credit' && !policy.monthly) ||
          (input.paymentMethodType === 'groupBilling' && !policy.group)
        )
          throw new ApiException(403, 'FORBIDDEN', '선택한 결제 방식의 사용 자격이 없습니다.');
      }
      await this.repository.seal(client, id, payload);
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'AI',
          targetId: id,
          targetType: 'CALL_SESSION',
          action: 'ORDER_INTAKE_COMPLETED',
          requestId,
        },
        client,
      );
    });
    await this.finalize(id, requestId);
    return this.detail(id, null);
  }

  private async lockDrafts(client: PoolClient, id: number): Promise<ParcelDraftRow[]> {
    const rows: ParcelDraftRow[] = [];
    for (const draftId of await this.repository.draftIds(client, id))
      rows.push((await this.drafts.draft(client, draftId))!);
    return rows;
  }

  async finalize(id: number, requestId: string): Promise<void> {
    let orderSeq: number | null = null;
    try {
      orderSeq = await writeOrder(this.database, async (client) => {
        const call = await this.drafts.call(client, id);
        if (!call?.enabled || !call.endedAt || !call.completionPayload || call.finalizedAt)
          return null;
        if (call.orderSeq !== null)
          throw new ApiException(409, 'INVALID_STATE', '확정 전에 다른 주문이 연결되어 있습니다.');
        const rows = await this.lockDrafts(client, id);
        const ready = rows.filter((row) => row.status === 'READY');
        if (!ready.length) {
          await this.repository.finish(client, id, null, []);
          await this.audit.recordSuccess(
            {
              actorId: null,
              actorType: 'SYSTEM',
              targetId: id,
              targetType: 'CALL_SESSION',
              action: 'ORDER_INTAKE_FINALIZED',
              requestId,
            },
            client,
          );
          return null;
        }
        if (
          call.customerSeq === null ||
          !(await this.drafts.customer(client, call.customerSeq)) ||
          ready.some((row) => row.customerSeq !== call.customerSeq)
        )
          throw new ApiException(
            403,
            'FORBIDDEN',
            '통화와 완성 초안에 연결된 활성 고객을 확인해 주세요.',
          );
        const draft = orderDraft({
          ...call.completionPayload,
          parcels: ready.map((row) => row.parcel),
          totalAmount: ready.reduce((sum, row) => sum + (row.parcel.notifiedPrice ?? 0), 0),
        });
        assertOrderAmount(draft);
        const created = await this.orders.insert(
          client,
          draft,
          call.customerSeq,
          randomUUID(),
          'AI',
          null,
          ready[0].reservedOrderSeq,
        );
        await this.calls.attachOrder(client, id, created.orderSeq);
        await this.submissions.prepareSubmission(
          client,
          created.orderSeq,
          call.customerSeq,
          null,
          requestId,
        );
        const parcels = await this.orders.parcelReferences(client, created.orderSeq);
        const mappings = ready.map((row, index) => ({
          draftSeq: row.draftSeq,
          orderParcelSeq: parcels[index].orderParcelSeq,
        }));
        await this.repository.finish(client, id, created.orderSeq, mappings);
        await this.audit.recordSuccess(
          {
            actorId: null,
            actorType: 'AI',
            targetId: created.orderSeq,
            targetType: 'ORDER',
            action: 'ORDER_CREATED',
            requestId,
          },
          client,
        );
        await this.audit.recordSuccess(
          {
            actorId: null,
            actorType: 'SYSTEM',
            targetId: id,
            targetType: 'CALL_SESSION',
            action: 'ORDER_INTAKE_FINALIZED',
            requestId,
          },
          client,
        );
        return created.orderSeq;
      });
    } catch (error) {
      const code =
        error instanceof ApiException
          ? (error.getResponse() as { code: string }).code
          : 'INTERNAL_ERROR';
      await this.repository.failed(id, code);
      this.logger.error({
        event: 'order_intake_finalization_deferred',
        callSessionSeq: id,
        code,
        requestId,
      });
      return;
    }
    if (orderSeq !== null) {
      try {
        await this.submissions.submitPaidOrder(orderSeq, requestId);
      } catch {
        this.logger.error({ event: 'order_intake_submission_deferred', orderSeq, requestId });
      }
    }
  }

  async recoverPending() {
    const candidates = await this.repository.candidates();
    // A batch of slow Dver responses must not serialize ahead of payment/retry maintenance.
    await Promise.all(
      candidates.map(async (id) => {
        try {
          await this.finalize(id, randomUUID());
        } catch {
          this.logger.error({ event: 'order_intake_recovery_failed', callSessionSeq: id });
        }
      }),
    );
  }

  async detail(
    id: number,
    adminId: number | null,
    header?: string,
  ): Promise<OrderIntakeResponseDto> {
    return this.database.transaction(async (client) => {
      if (adminId === null && header !== undefined && this.access.headerId(header) !== id)
        throw new ApiException(403, 'FORBIDDEN', '요청 경로와 통화 번호가 다릅니다.');
      const call = await this.drafts.call(client, id, false);
      if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (!call.enabled) throw new ApiException(409, 'INVALID_STATE', '이전 계약의 통화입니다.');
      const result = call.finalizationResult;
      const status = result
        ? result.orderSeq === null
          ? 'NO_ORDER'
          : 'FINALIZED'
        : !call.completionReceivedAt
          ? call.endedAt
            ? 'WAITING_AI'
            : 'COLLECTING'
          : !call.endedAt
            ? 'WAITING_PBX'
            : call.errorCode
              ? 'FAILED'
              : 'FINALIZING';
      const order = result?.orderSeq ? await this.orders.result(client, result.orderSeq, id) : null;
      return {
        callSessionSeq: id,
        intakeVersion: call.intakeVersion,
        status,
        endedAt: call.endedAt,
        completionReceivedAt: call.completionReceivedAt,
        finalizedAt: call.finalizedAt,
        errorCode: call.errorCode,
        orderSeq: result?.orderSeq ?? null,
        parcelMappings: result?.parcelMappings ?? [],
        order: order ?? null,
      };
    });
  }
}
