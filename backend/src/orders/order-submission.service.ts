import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { OrdersRepository } from './orders.repository';
import { DverClient, DverResult, dverPayload } from './dver.client';
import { OrderSubmissionRepository } from './order-submission.repository';
import { OrderPaymentsRepository } from './order-payments.repository';
import { SubmittedOrderDto } from './dto/submit-order.dto';
import { assertOrderAmount } from './order-pricing';
import { assertOrderSubmissionReady } from './order-submission.validation';
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
    private readonly payments: OrderPaymentsRepository,
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
    await this.database.transaction(async (client) => {
      for (const id of await this.submissions.recoveryCandidates(client))
        await this.recoverStale(client, id, randomUUID());
    });
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
      if (!(await this.repository.submissionAllowed(client, id)))
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
      const snapshot = (await this.repository.detail(client, id, null))!;
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

  async prepareSubmission(
    client: PoolClient,
    id: number,
    customerId: number,
    adminId: number | null,
    requestId: string,
  ) {
    const snapshot = (await this.repository.detail(client, id, null))!;
    const policy = await this.payments.eligibility(client, customerId);
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
    if (await this.submissions.hasShipments(client, id))
      throw new ApiException(409, 'INVALID_STATE', '이미 배송 정보가 생성된 주문입니다.');
    const usablePinIds = await this.repository.usablePersonalPinIds(
      client,
      customerId,
      snapshot.parcels
        .filter((parcel) => parcel.status !== 'CANCELLED')
        .flatMap((parcel) => (parcel.originPin ? [parcel.originPin] : [])),
    );
    for (const parcel of snapshot.parcels) {
      if (parcel.status === 'CANCELLED') continue;
      if (
        parcel.originPin &&
        parcel.originPin.scope === 'PERSONAL' &&
        !usablePinIds.has(parcel.originPin.pinSeq)
      )
        throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
    }
    if (snapshot.creationSource === 'ADMIN')
      for (const pin of await this.repository.saveRecipientPins(client, id, customerId))
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            actorType: adminId === null ? 'AI' : 'ADMIN',
            targetId: pin.personalPinSeq,
            targetType: 'PERSONAL_PIN',
            action: 'PERSONAL_PIN_CREATED',
            requestId,
          },
          client,
        );
    if (snapshot.paymentMethodType === 'billing' || snapshot.paymentMethodType === 'groupBilling') {
      if (snapshot.paymentMethodType === 'groupBilling')
        await this.payments.prepareCompanyCard(
          client,
          id,
          policy.organizationSeq!,
          policy.departmentSeq,
        );
      await this.payments.waitForPayment(client, id);
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
      return undefined;
    }
    this.dver.ensureConfigured();
    await this.payments.billed(client, id, policy.organizationSeq, policy.departmentSeq, requestId);
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
      const status = await this.database.transaction(async (client) => {
        const saved = await this.submissions.finish(client, id, result, attempt);
        if (!saved)
          return (await this.repository.lockOrder(client, id))?.status ?? 'SUBMISSION_FAILED';
        await this.audit.recordSuccess(
          {
            ...event,
            action:
              result.status === 'ACCEPTED'
                ? 'ORDER_SUBMISSION_ACCEPTED'
                : 'ORDER_SUBMISSION_FAILED',
          },
          client,
        );
        return saved;
      });
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
}
