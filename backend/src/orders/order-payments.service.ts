import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { OrderPaymentsRepository } from './order-payments.repository';
import { OrderSubmissionService } from './order-submission.service';
import { OrdersRepository } from './orders.repository';
import { orderItemPriceError } from './order-pricing';
import { randomUUID } from 'node:crypto';
import { PaymentCardsService } from '../payments/payment-cards.service';

// Internal domain seam. PaymentsService reserves a durable provider key and lease
// before calling confirmPayment; no route accepts an AI/admin claim of success.
@Injectable()
export class OrderPaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrderPaymentsRepository,
    private readonly audit: AuditService,
    private readonly submissions: OrderSubmissionService,
    private readonly orders: OrdersRepository,
    private readonly cards: PaymentCardsService,
  ) {}

  async claimApproval(id: string, amount: number, key?: string) {
    return this.database.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='2s'");
      const activeCustomer = await this.repository.lockActivePaymentCustomer(client, id);
      const r = await this.repository.request(client, id);
      if (!r || r.order.retentionExpired)
        throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      if (r.paymentCardSeq !== null)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '등록 카드 결제는 기존 거래 결과를 확인해 주세요.',
        );
      if (r.amount !== amount || (key && r.providerPaymentKey && r.providerPaymentKey !== key))
        throw new ApiException(409, 'INVALID_STATE', '결제 정보가 일치하지 않습니다.');
      if (r.completedAt)
        return { done: true as const, key: r.providerReference!, claimId: null, lookupOnly: true };
      if (
        r.invalidatedAt ||
        r.order.status !== 'notPaid' ||
        r.order.totalAmount !== amount ||
        (!r.approvalStartedAt && r.expiresAt.getTime() <= Date.now())
      )
        throw new ApiException(409, 'INVALID_STATE', '유효한 결제 대기 요청이 아닙니다.');
      if (r.approvalClaimedUntil && r.approvalClaimedUntil.getTime() > Date.now())
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '결제 결과를 확인 중입니다.');
      const paymentKey = r.providerPaymentKey || key;
      if (!paymentKey) throw new ApiException(409, 'INVALID_STATE', '조회할 결제 정보가 없습니다.');
      if (!r.approvalStartedAt) {
        if (!activeCustomer)
          throw new ApiException(403, 'FORBIDDEN', '탈퇴·삭제된 고객의 결제 요청입니다.');
        const snapshot = await this.orders.detail(client, r.orderSeq, null);
        if (!snapshot) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
        const errors = snapshot.parcels.flatMap((parcel, index) => {
          const reason = parcel.status !== 'CANCELLED' && orderItemPriceError(parcel.itemPrice);
          return reason ? [{ field: `parcels.${index}.itemPrice`, reason }] : [];
        });
        if (errors.length)
          throw new ApiException(
            422,
            'VALIDATION_FAILED',
            '물품가액은 1원~1억원 정수로 입력해 주세요.',
            errors,
          );
      }
      const claimId = randomUUID();
      if (!(await this.repository.reserveApproval(client, id, paymentKey, claimId)))
        throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      return { done: false as const, key: paymentKey, claimId, lookupOnly: !!r.approvalStartedAt };
    });
  }

  releaseClaim(id: string, claimId: string, declined = false) {
    return this.repository.releaseClaim(id, claimId, declined);
  }

  async recordPaymentFailure(
    id: string,
    requestId: string,
    error: unknown,
    action: 'ORDER_PAYMENT_CONFIRMATION' | 'ORDER_PAYMENT_RECONCILED' | 'ORDER_CARD_PAYMENT',
  ) {
    let orderId: number | null = null;
    try {
      orderId = await this.repository.paymentOrderId(id);
    } catch {
      /* Preserve the payment error when the DB is unavailable. */
    }
    const response = error instanceof ApiException ? error.getResponse() : null;
    const code =
      response && typeof response === 'object' && 'code' in response ? response.code : null;
    await this.audit.recordFailure(
      {
        actorId: null,
        actorType: 'SYSTEM',
        targetType: 'ORDER',
        targetId: orderId,
        action,
        requestId,
        metadata: {
          reason:
            code === 'PAYMENT_FAILED'
              ? 'PAYMENT_DECLINED'
              : code === 'PAYMENT_RESULT_UNKNOWN'
                ? 'PAYMENT_RESULT_UNKNOWN'
                : 'PAYMENT_REQUEST_FAILED',
        },
      },
      error,
    );
  }

  async claimCardApproval(id: string) {
    return this.database.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='2s'");
      const activeCustomer = await this.repository.lockActivePaymentCustomer(client, id);
      const r = await this.repository.request(client, id);
      if (!r || r.order.retentionExpired)
        throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      if (r.completedAt) return { done: true as const };
      if (
        !r.paymentCardSeq ||
        r.invalidatedAt ||
        r.order.status !== 'notPaid' ||
        r.amount !== r.order.totalAmount ||
        (!r.approvalStartedAt && r.expiresAt.getTime() <= Date.now())
      )
        throw new ApiException(409, 'INVALID_STATE', '유효한 등록 카드 결제 요청이 아닙니다.');
      if (r.approvalClaimedUntil && r.approvalClaimedUntil.getTime() > Date.now())
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '카드 승인 결과를 확인 중입니다.');
      let card: Awaited<ReturnType<OrderPaymentsRepository['card']>> | undefined = undefined;
      if (!r.approvalStartedAt) {
        const policy = await this.repository.eligibility(client, r.order.customerSeq);
        if (
          !activeCustomer ||
          (r.order.paymentMethodType === 'groupBilling' &&
            (!policy.group || policy.organizationSeq !== r.order.billingOrganizationSeq))
        )
          throw new ApiException(403, 'FORBIDDEN', '현재 고객의 카드 결제 자격이 없습니다.');
        card = await this.repository.card(
          client,
          r.order.paymentMethodType === 'billing' ? r.order.customerSeq : null,
          r.order.paymentMethodType === 'groupBilling' ? r.order.billingOrganizationSeq : null,
        );
        if (!card || (r.cardPaymentFailed && card.paymentCardSeq === r.paymentCardSeq))
          throw new ApiException(409, 'INVALID_STATE', '결제 카드가 변경되었습니다.');
        if (card.paymentCardSeq !== r.paymentCardSeq) {
          const orderId = randomUUID();
          await this.repository.retryCard(client, id, card.paymentCardSeq, orderId);
          r.paymentCardSeq = card.paymentCardSeq;
          r.cardPaymentOrderId = orderId;
        }
        const snapshot = await this.orders.detail(client, r.orderSeq, null);
        if (!snapshot) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
        const errors = snapshot.parcels.flatMap((p, index) =>
          p.status !== 'CANCELLED' && orderItemPriceError(p.itemPrice)
            ? [{ field: `parcels.${index}.itemPrice`, reason: orderItemPriceError(p.itemPrice)! }]
            : [],
        );
        if (errors.length)
          throw new ApiException(422, 'VALIDATION_FAILED', '물품가액을 확인해 주세요.', errors);
      }
      const claimId = randomUUID();
      const billingKey = card ? this.cards.decrypt(card) : undefined;
      await this.repository.reserveCardApproval(client, id, claimId);
      return {
        done: false as const,
        amount: r.amount,
        orderId: r.cardPaymentOrderId,
        lookupOnly: !!r.approvalStartedAt,
        card,
        billingKey,
        claimId,
      };
    });
  }

  failCardApproval(id: string, claimId: string) {
    return this.repository.failCardApproval(id, claimId);
  }

  recordApproval(id: string, key: string, approvedAt: string) {
    return this.repository.recordApproval(id, key, approvedAt);
  }

  recordCardApproval(id: string, key: string, approvedAt: string) {
    return this.repository.recordCardApproval(id, key, approvedAt);
  }

  claimNotification() {
    return this.repository.claimNotification();
  }
  finishNotification(id: string, status: string) {
    return this.repository.finishNotification(id, status);
  }
  claimCompletionNotification() {
    return this.repository.claimCompletionNotification();
  }
  finishCompletionNotification(id: string, status: string) {
    return this.repository.finishCompletionNotification(id, status);
  }

  async retryNotification(id: string, adminId: number, requestId: string) {
    await this.database.transaction(async (client) => {
      const r = await this.repository.request(client, id);
      if (!r) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      if (
        r.completedAt ||
        r.invalidatedAt ||
        r.approvalStartedAt ||
        r.order.status !== 'notPaid' ||
        r.expiresAt.getTime() <= Date.now() ||
        r.notificationStatus === 'SENDING'
      )
        throw new ApiException(409, 'INVALID_STATE', '재발송할 수 있는 결제 대기 요청이 아닙니다.');
      if (r.notificationStatus === 'PENDING') return;
      await this.repository.queueNotification(client, id);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: 'ADMIN',
          targetType: 'ORDER',
          targetId: r.orderSeq,
          action: 'ORDER_PAYMENT_NOTIFICATION_RETRIED',
          requestId,
        },
        client,
      );
    });
  }

  async retryCompletionNotification(id: string, adminId: number, requestId: string) {
    await this.database.transaction(async (client) => {
      const r = await this.repository.request(client, id);
      if (!r) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      const status = await this.repository.completionStatus(client, id);
      if (!r.completedAt || status === 'SENDING')
        throw new ApiException(
          409,
          'INVALID_STATE',
          '결제 완료 후 발송 중이 아닐 때만 재발송할 수 있습니다.',
        );
      if (['WAITING', 'PENDING'].includes(status)) return;
      await this.repository.queueCompletionNotification(client, id);
      await this.audit.recordSuccess(
        {
          actorId: adminId,
          actorType: 'ADMIN',
          targetType: 'ORDER',
          targetId: r.orderSeq,
          action: 'ORDER_PAYMENT_COMPLETION_NOTIFICATION_RETRIED',
          requestId,
        },
        client,
      );
    });
  }
  async confirmPayment(
    id: string,
    amount: number,
    providerReference: string,
    requestId: string,
    approvedAt?: string,
  ) {
    if (!providerReference || providerReference.length > 200)
      throw new ApiException(400, 'INVALID_REQUEST', '검증된 결제 거래 식별자가 필요합니다.');
    const orderId = await this.database.transaction(async (client) => {
      const request = await this.repository.request(client, id);
      if (!request) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      if (request.completedAt) {
        if (request.providerReference !== providerReference || request.amount !== amount)
          throw new ApiException(409, 'INVALID_STATE', '이미 완료된 결제와 일치하지 않습니다.');
        return request.orderSeq;
      }
      if (
        !request.approvalStartedAt ||
        (request.paymentCardSeq !== null && request.providerPaymentKey !== providerReference) ||
        request.invalidatedAt ||
        request.order.status !== 'notPaid' ||
        request.amount !== amount ||
        request.order.totalAmount !== amount
      )
        throw new ApiException(409, 'INVALID_STATE', '결제 승인 대상이 변경되었습니다.');
      await this.repository.complete(client, id, providerReference);
      await this.repository.billed(
        client,
        request.orderSeq,
        request.order.paymentMethodType === 'groupBilling'
          ? request.order.billingOrganizationSeq
          : null,
        request.order.paymentMethodType === 'groupBilling'
          ? request.order.billingDepartmentSeq
          : null,
        requestId,
        approvedAt,
      );
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'SYSTEM',
          targetId: request.orderSeq,
          targetType: 'ORDER',
          action: 'ORDER_PAYMENT_COMPLETED',
          requestId,
          metadata: { amountAfter: amount },
        },
        client,
      );
      return request.orderSeq;
    });
    return this.submissions.submitPaidOrder(orderId, requestId);
  }
}
