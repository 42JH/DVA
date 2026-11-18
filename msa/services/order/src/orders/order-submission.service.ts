import { BillingService } from '../billing/billing.service';
import { PaymentsRepository } from '../payments/payments.repository';
import { ParcelDraftWriteScope } from './parcel-draft-write-scope.service';
import { OrderShipmentCheckClient } from './order-shipment-check.client';
import { assertOrderSubmissionReady } from './order-submission.validation';
import type { RecipientAddress } from '@dva/events/order-recipient-pins.cjs';
import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { OrdersRepository } from './orders.repository';
import { DverClient, DverResult, dverPayload } from './dver.client';
import { OrderSubmissionRepository } from './order-submission.repository';
import { OrderDeletionCheckClient } from './order-deletion-check.client';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { sendEvent } from '@dva/events';
import { SubmittedOrderDto } from './dto/submit-order.dto';
import { assertOrderAmount } from './order-pricing';
import { writeOrder } from './order-write';
import { randomUUID } from 'node:crypto';
import { OrderStatus } from './orders.types';

@Injectable()
export class OrderSubmissionService {
  private readonly logger = new Logger(OrderSubmissionService.name);
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly submissions: OrderSubmissionRepository,
    private readonly dver: DverClient,
    private readonly callCheck: OrderDeletionCheckClient,
    private readonly config: ConfigService<Environment, true>,
    private readonly billing: BillingService,
    private readonly payments: PaymentsRepository,
    private readonly scope: ParcelDraftWriteScope,
    private readonly shipmentCheck: OrderShipmentCheckClient,
  ) {}

  async recoverStale(
    client: PoolClient,
    id: number,
    requestId: string,
  ): Promise<OrderStatus | undefined> {
    const status = await this.submissions.markStale(client, id);
    if (!status) return;
    await this.audit.recordSuccess(
      {
        actorId: null,
        actorType: 'SYSTEM',
        targetId: id,
        targetType: 'ORDER',
        action: 'ORDER_SUBMISSION_FAILED',
        requestId,
      },
      client,
    );
    return status;
  }

  async recoverPending(): Promise<void> {
    const pending = await this.database.pool.query<{ id: number; eventId: string }>(
      `SELECT aggregate_seq AS id,event_id AS "eventId" FROM outbox_events
       WHERE destination='delivery' AND event_type='OrderSubmissionDeliveryRequested'
         AND delivered_at IS NULL AND next_attempt_at<=clock_timestamp()
       ORDER BY next_attempt_at,outbox_seq LIMIT 20`,
    );
    for (const event of pending.rows) {
      try {
        await this.finishAccepted(event.id, event.eventId);
      } catch {
        await this.database.pool.query(
          `UPDATE outbox_events SET next_attempt_at=clock_timestamp()+interval '10 seconds'
           WHERE event_id=$1 AND delivered_at IS NULL`,
          [event.eventId],
        );
        this.logger.error({ event: 'order_delivery_deferred', orderSeq: event.id });
      }
    }
    await this.database.transaction(async (client) => {
      for (const id of await this.submissions.recoveryCandidates(client))
        await this.recoverStale(client, id, randomUUID());
    });
  }

  async recoverPaid(): Promise<void> {
    const pending = await this.database.pool.query<{
      id: number;
      status: 'PAID' | 'SUBMITTING_FAILED';
      updatedAt: string;
    }>(
      `SELECT order_seq AS id,status,updated_at::text AS "updatedAt" FROM orders
       WHERE deleted_at IS NULL AND COALESCE(closed_at,created_at)>statement_timestamp()-interval '5 years'
        AND (submission_first_attempt_at IS NULL OR submission_first_attempt_at>statement_timestamp()-interval '10 minutes')
        AND (submission_last_attempt_at IS NULL OR submission_last_attempt_at<=statement_timestamp()-interval '1 minute')
        AND status IN ('PAID','SUBMITTING_FAILED')
       ORDER BY submission_last_attempt_at NULLS FIRST,order_seq LIMIT 20`,
    );
    await Promise.all(
      pending.rows.map(async (order) => {
        try {
          await this.submitPaidOrder(
            order.id,
            randomUUID(),
            null,
            order.status === 'SUBMITTING_FAILED',
            order.updatedAt,
          );
        } catch {
          this.logger.error({ event: 'paid_order_submission_deferred', orderSeq: order.id });
        }
      }),
    );
  }

  async submitPaidOrder(
    id: number,
    requestId: string,
    adminId: number | null = null,
    retry = false,
    expectedUpdatedAt?: string,
  ): Promise<SubmittedOrderDto> {
    const prepared = await writeOrder(this.database, async (client) => {
      const order = await this.repository.lockOrder(client, id);
      if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      if (!(await this.callCheck.submissionAllowed(id)))
        throw new ApiException(409, 'INVALID_STATE', '통화 종료와 AI 주문 입력 확정이 필요합니다.');
      if (order.status === 'SUBMITTING') {
        const recovered = await this.recoverStale(client, id, requestId);
        return { status: recovered ?? order.status };
      }
      if (expectedUpdatedAt !== undefined) {
        const recovered = await this.recoverStale(client, id, requestId);
        if (recovered) return { status: recovered };
      }
      if (
        order.status !== 'PAID' &&
        !(retry && ['SUBMITTING_FAILED', 'SUBMISSION_FAILED'].includes(order.status))
      )
        return { status: order.status };
      const snapshot = await this.repository.detail(client, id, null);
      // Payment fixes pickup at paid_at + 1 hour. Retries preserve that snapshot.
      const payload = dverPayload(snapshot, 0);
      assertOrderAmount(snapshot);
      this.dver.ensureConfigured();
      // A worker snapshot is consumed once even if another attempt has already failed again.
      const attempt = await this.submissions.start(client, id, expectedUpdatedAt);
      if (!attempt) return { status: order.status };
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: adminId === null ? 'SYSTEM' : 'ADMIN',
          targetId: id,
          targetType: 'ORDER',
          action: retry ? 'ORDER_RESUBMISSION_STARTED' : 'ORDER_SUBMISSION_STARTED',
          requestId,
        },
        client,
      );
      return { payload, ...attempt };
    });
    if ('status' in prepared) return { status: prepared.status! };
    return this.finishSubmission(
      id,
      requestId,
      prepared.payload,
      prepared.attempt,
      prepared.timeoutMs,
    );
  }

  async retry(id: number, adminId: number, requestId: string) {
    const order = await this.database.transaction((client) =>
      this.repository.lockOrder(client, id),
    );
    if (!order) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
    if (
      !['SUBMISSION_FAILED', 'SUBMITTING_FAILED', 'SUBMITTING', 'ACCEPTED'].includes(order.status)
    )
      throw new ApiException(409, 'INVALID_STATE', '디버 접수 실패 주문만 재접수할 수 있습니다.');
    return this.submitPaidOrder(id, requestId, adminId, true);
  }

  private async finishAccepted(id: number, eventId: string): Promise<OrderStatus> {
    return this.database.transaction(async (client) => {
      const order = await this.repository.lockOrder(client, id);
      const acceptance = await this.submissions.acceptance(client, id, eventId);
      if (!acceptance) return order?.status ?? 'SUBMISSION_FAILED';
      await sendEvent(
        this.config.get('DELIVERY_URL', { infer: true }) + '/internal/order-accepted',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId,
          source: 'order',
          eventType: 'OrderSubmissionDeliveryRequested',
          payload: { orderParcelSeqs: acceptance.orderParcelSeqs },
        },
      );
      const status = await this.submissions.finish(
        client,
        id,
        acceptance.result,
        acceptance.attempt,
      );
      if (!status) throw new Error('Submission attempt changed before delivery confirmation');
      await client.query(
        'UPDATE outbox_events SET delivered_at=clock_timestamp() WHERE event_id=$1',
        [eventId],
      );
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'SYSTEM',
          targetId: id,
          targetType: 'ORDER',
          action: 'ORDER_SUBMISSION_ACCEPTED',
          requestId: acceptance.requestId,
        },
        client,
      );
      return status;
    });
  }

  private async finishSubmission(
    id: number,
    requestId: string,
    payload: ReturnType<typeof dverPayload>,
    attempt: string,
    timeoutMs: number,
  ): Promise<SubmittedOrderDto> {
    const event = {
      actorId: null,
      actorType: 'SYSTEM' as const,
      targetId: id,
      targetType: 'ORDER',
      requestId,
    };
    // SUBMITTING을 COMMIT한 요청만 전송하며 이 구간에는 DB 트랜잭션이 없다.
    let result: DverResult;
    try {
      result = await this.dver.submit(payload, timeoutMs);
    } catch {
      result = { status: 'SUBMISSION_FAILED' };
    }
    try {
      let status: OrderStatus;
      if (result.status === 'ACCEPTED') {
        const accepted = result;
        const eventId = await this.database.transaction((client) =>
          this.submissions.queueAcceptance(client, id, requestId, accepted, attempt),
        );
        // Keep the positive provider result durable until delivery commits its side effects.
        status = eventId
          ? await this.finishAccepted(id, eventId)
          : await this.database.transaction(
              async (client) =>
                (await this.repository.lockOrder(client, id))?.status ?? 'SUBMISSION_FAILED',
            );
      } else {
        status = await this.database.transaction(async (client) => {
          const saved = await this.submissions.finish(client, id, result, attempt);
          if (!saved)
            return (await this.repository.lockOrder(client, id))?.status ?? 'SUBMISSION_FAILED';
          await this.audit.recordSuccess({ ...event, action: 'ORDER_SUBMISSION_FAILED' }, client);
          return saved;
        });
      }
      this.logger.log({
        event: 'order_submission_result',
        orderSeq: id,
        requestId,
        outcome: status,
      });
      return { status };
    } catch {
      this.logger.error({ event: 'order_submission_result_save_failed', orderSeq: id, requestId });
      // 외부 접수가 성공했을 수 있다. 저장 실패 후에도 같은 주문을 다시 전송하지 않는다.
      return { status: 'SUBMITTING' };
    }
  }
  async prepareSubmission(
    client: PoolClient,
    id: number,
    customerId: number,
    adminId: number | null,
    requestId: string,
  ) {
    const snapshot = await this.repository.detail(client, id, null);
    const policy = await this.scope.paymentPolicy(customerId);
    if (snapshot.paymentMethodType === null && policy.organizationSeq !== null && policy.monthly) {
      await this.payments.defaultMonthly(client, id);
      snapshot.paymentMethodType = 'credit';
    }
    assertOrderSubmissionReady(snapshot, Date.now(), false);
    assertOrderAmount(snapshot);
    if (
      (snapshot.paymentMethodType === 'credit' && !policy.monthly) ||
      (snapshot.paymentMethodType === 'groupBilling' && !policy.group)
    )
      throw new ApiException(403, 'FORBIDDEN', '선택한 결제 방식의 사용 자격이 없습니다.');
    for (let offset = 0; offset < snapshot.parcels.length; offset += 250)
      if (
        await this.shipmentCheck.blocked(
          snapshot.parcels.slice(offset, offset + 250).map((parcel) => parcel.orderParcelSeq),
        )
      )
        throw new ApiException(409, 'INVALID_STATE', '이미 배송 정보가 생성된 주문입니다.');
    for (const parcel of snapshot.parcels)
      if (
        parcel.status !== 'CANCELLED' &&
        parcel.originPin?.scope === 'PERSONAL' &&
        !(await this.scope.canUsePin(customerId, parcel.originPin.pinSeq))
      )
        throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
    if (snapshot.creationSource === 'ADMIN') {
      const addresses = snapshot.parcels
        .filter((parcel) => parcel.status !== 'CANCELLED')
        .map((parcel) => ({
          ...parcel.destination,
          detailAddress: parcel.destination.detailAddress ?? '',
        })) as RecipientAddress[];
      await this.scope.prepareRecipientPins(client, id, customerId, addresses, adminId, requestId);
    }
    if (snapshot.paymentMethodType === 'billing' || snapshot.paymentMethodType === 'groupBilling') {
      if (snapshot.paymentMethodType === 'groupBilling')
        await this.payments.prepareCompanyCard(
          client,
          id,
          await this.scope.paymentPolicy(customerId),
        );
      await client.query(
        "UPDATE orders SET status='notPaid',payment_due_at=clock_timestamp()+interval '24 hours' WHERE order_seq=$1",
        [id],
      );
      await this.repository.replaceRequest(client, id);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: adminId === null ? 'AI' : 'ADMIN',
          targetId: id,
          targetType: 'ORDER',
          action: 'ORDER_PAYMENT_PENDING',
          requestId,
          metadata: { amountAfter: snapshot.totalAmount },
        },
        client,
      );
      return;
    }
    this.dver.ensureConfigured();
    const paidPolicy = await this.scope.paymentPolicy(customerId);
    await this.payments.markPaid(client, id, undefined, paidPolicy);
    await this.billing.recordCharge(client, id, requestId);
    await this.audit.recordSuccess(
      {
        actorId: null,
        actorType: 'SYSTEM',
        targetId: id,
        targetType: 'ORDER',
        action: 'ORDER_PAYMENT_COMPLETED',
        requestId,
        metadata: { amountAfter: snapshot.totalAmount },
      },
      client,
    );
    return true;
  }
}
