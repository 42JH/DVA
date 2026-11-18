import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { enqueue, sendEvent } from '@dva/events';
import type { DraftWriteEvent } from '@dva/events/parcel-draft-write.cjs';
import type { IntakeFinalization, IntakeCompletion } from '@dva/events/order-intake-write.cjs';
import type { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { createValidationPipe } from '../common/http/validation.pipe';
import { AuditService } from '../audit/audit.service';
import { ParcelDraftWriteScope } from './parcel-draft-write-scope.service';
import { ParcelDraftWritesRepository } from './parcel-draft-writes.repository';
import { OrdersRepository } from './orders.repository';
import { OrderSubmissionService } from './order-submission.service';
import { CompleteOrderIntakeDto } from './dto/complete-order-intake.dto';
import { orderDraft } from './order-draft';
import { assertOrderAmount } from './order-pricing';
import type { ParcelDraftRow } from './parcel-drafts.types';
import { PaymentsService } from '../payments/payments.service';

@Injectable()
export class OrderIntakeWritesService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly scope: ParcelDraftWriteScope,
    private readonly drafts: ParcelDraftWritesRepository,
    private readonly orders: OrdersRepository,
    private readonly audit: AuditService,
    private readonly submissions: OrderSubmissionService,
    private readonly payments: PaymentsService,
  ) {}

  execute(event: DraftWriteEvent) {
    return this.scope.run(event, async () => {
      const command = event.payload.command;
      if (command.operation === 'OrderIntakeSealed') {
        const input: unknown = await createValidationPipe().transform(command.input, {
          type: 'body',
          metatype: CompleteOrderIntakeDto,
        });
        return this.scope.transaction((client) =>
          this.seal(client, command.id!, input as CompleteOrderIntakeDto),
        );
      }
      return this.scope.transaction((client) =>
        this.finalize(client, command.id!, command.requestId),
      );
    });
  }

  async recoverPending() {
    await sendEvent(
      this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/parcel-draft-write/recover',
      this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
      {
        eventId: randomUUID(),
        source: 'order',
        eventType: 'OrderIntakeRecoveryRequested',
        payload: {},
      },
      null,
    );
  }
  async submitPaidOrder(id: number, requestId: string) {
    await this.payments.forOrder(id, requestId);
    await this.submissions.submitPaidOrder(id, requestId);
  }

  private async lockDrafts(client: PoolClient, id: number): Promise<ParcelDraftRow[]> {
    const ids = (
      await client.query<{ id: number }>(
        `SELECT draft_seq AS id FROM order_parcel_drafts WHERE call_session_seq=$1 AND deleted_at IS NULL
      AND retention_started_at>statement_timestamp()-interval '5 years' ORDER BY draft_seq FOR UPDATE`,
        [id],
      )
    ).rows;
    const rows: ParcelDraftRow[] = [];
    for (const { id } of ids) {
      const row = await this.drafts.draft(client, id, true);
      if (row) rows.push(row);
    }
    return rows;
  }

  private async seal(client: PoolClient, id: number, input: CompleteOrderIntakeDto) {
    const payload: IntakeCompletion = {
      expectedIntakeVersion: input.expectedIntakeVersion,
      ...(input.paymentMethodType ? { paymentMethodType: input.paymentMethodType } : {}),
      pickupRequestedAt: input.pickupRequestedAt
        ? new Date(input.pickupRequestedAt).toISOString()
        : null,
    };
    const call = await this.scope.intakeCall(id);
    if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
    if (!call.enabled) throw new ApiException(409, 'INVALID_STATE', '이전 계약의 통화입니다.');
    if (call.completionPayload) {
      if (!isDeepStrictEqual(call.completionPayload, payload))
        throw new ApiException(
          409,
          'EVENT_PAYLOAD_CONFLICT',
          '이미 확정한 통화 주문 완료 내용과 다릅니다.',
        );
      return { sealed: true };
    }
    if (call.orderSeq !== null)
      throw new ApiException(409, 'INVALID_STATE', '이미 주문이 연결된 통화입니다.');
    if (call.intakeVersion !== input.expectedIntakeVersion)
      throw new ApiException(
        409,
        'VERSION_CONFLICT',
        '마지막 초안 저장 응답의 intakeVersion을 확인해 주세요.',
      );
    await this.drafts.lockScope(client, call.customerSeq, call.callerPhoneNumber);
    const ready = (await this.lockDrafts(client, id)).filter((row) => row.status === 'READY');
    if (ready.length) {
      assertOrderAmount({
        totalAmount: ready.reduce((sum, row) => sum + (row.parcel.notifiedPrice ?? 0), 0),
        parcels: ready.map((row) => row.parcel),
      });
      if (call.customerSeq === null || !(await this.drafts.customer(client, call.customerSeq)))
        throw new ApiException(403, 'FORBIDDEN', '통화에 연결된 활성 고객이 필요합니다.');
      const policy = await this.scope.paymentPolicy(call.customerSeq);
      if (!input.paymentMethodType && !(policy.organizationSeq !== null && policy.monthly))
        throw new ApiException(
          422,
          'VALIDATION_FAILED',
          '완성된 배송 초안에는 결제수단이 필요합니다.',
        );
      if (
        (input.paymentMethodType === 'credit' && !policy.monthly) ||
        (input.paymentMethodType === 'groupBilling' && !policy.group)
      )
        throw new ApiException(403, 'FORBIDDEN', '선택한 결제 방식의 사용 자격이 없습니다.');
    }
    await this.scope.sealIntake(id, payload);
    return { sealed: true };
  }

  private async finalize(
    client: PoolClient,
    id: number,
    requestId: string,
  ): Promise<{ finalization: IntakeFinalization | null }> {
    const call = await this.scope.intakeCall(id);
    if (!call?.enabled || !call.endedAt || !call.completionPayload || call.finalizedAt)
      return { finalization: null };
    if (call.orderSeq !== null)
      throw new ApiException(409, 'INVALID_STATE', '확정 전에 다른 주문이 연결되어 있습니다.');
    await this.drafts.lockScope(client, call.customerSeq, call.callerPhoneNumber);
    const ready = (await this.lockDrafts(client, id)).filter((row) => row.status === 'READY');
    let orderSeq: number | null = null;
    let parcelMappings: IntakeFinalization['parcelMappings'] = [];
    if (ready.length) {
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
      orderSeq = created.orderSeq;
      await this.submissions.prepareSubmission(client, orderSeq, call.customerSeq, null, requestId);
      const parcels = await this.orders.parcelReferences(client, orderSeq);
      parcelMappings = ready.map((row, index) => ({
        draftSeq: row.draftSeq,
        orderParcelSeq: parcels[index].orderParcelSeq,
      }));
      for (const mapping of parcelMappings)
        await client.query(
          `UPDATE order_parcel_drafts SET status='CONVERTED',order_parcel_seq=$2,
        order_seq=$3,version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1`,
          [mapping.draftSeq, mapping.orderParcelSeq, orderSeq],
        );
    }
    await client.query(
      `UPDATE order_parcel_drafts SET status='INCOMPLETE',version=version+1,updated_at=clock_timestamp()
      WHERE call_session_seq=$1 AND status='EDITING' AND deleted_at IS NULL`,
      [id],
    );
    const finalizedAt = (
      await client.query<{ at: Date }>('SELECT clock_timestamp() AS at')
    ).rows[0].at.toISOString();
    const eventId = await enqueue(client, {
      destination: 'consultation',
      eventType: 'OrderIntakeFinalized',
      aggregateSeq: id,
      payload: { callSessionSeq: id },
    });
    if (orderSeq !== null)
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'AI',
          targetId: orderSeq,
          targetType: 'ORDER',
          action: 'ORDER_CREATED',
          requestId,
        },
        client,
      );
    return {
      finalization: {
        eventId,
        callSessionSeq: id,
        expectedIntakeVersion: call.intakeVersion,
        finalizedAt,
        orderSeq,
        parcelMappings,
        requestId,
      },
    };
  }
}
