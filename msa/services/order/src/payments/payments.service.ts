import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { PaymentsRepository } from './payments.repository';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { PaymentClient } from './payment.client';
import { randomUUID } from 'node:crypto';
import { isZonedDate } from '../orders/order-draft';
import { orderItemPriceError } from '../orders/order-pricing';
import { OrdersRepository } from '../orders/orders.repository';
import { OrderSubmissionService } from '../orders/order-submission.service';
import { paymentCompletionMessage, paymentMessage } from './payment-message';
@Injectable()
export class PaymentsService {
  private readonly active = new Map<string, { key: string; promise: Promise<unknown> }>();
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: PaymentsRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly client: PaymentClient,
    private readonly ordersRepository: OrdersRepository,
    private readonly submissions: OrderSubmissionService,
  ) {}
  ensureEnabled() {
    if (!this.config.get('ORDER_PAYMENTS_ENABLED', { infer: true }))
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '주문 결제 연동이 설정되지 않았습니다.',
      );
  }
  async read(id: string) {
    this.ensureEnabled();
    return this.repository.read(id);
  }

  confirm(id: string, orderId: string, amount: number, key: string, requestId: string) {
    this.ensureEnabled();
    if (id !== orderId)
      throw new ApiException(400, 'INVALID_REQUEST', '결제 주문번호가 일치하지 않습니다.');
    const active = this.active.get(id);
    if (active) {
      if (active.key !== `${key}:${amount}`)
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '다른 결제 요청을 처리 중입니다.');
      return active.promise;
    }
    const promise = this.process(id, amount, key, requestId).finally(() => this.active.delete(id));
    this.active.set(id, { key: `${key}:${amount}`, promise });
    return promise;
  }
  async reconcile(id: string, requestId: string) {
    const view = await this.read(id);
    return this.process(id, view.amount, undefined, requestId);
  }
  private async process(id: string, amount: number, key: string | undefined, requestId: string) {
    const claim = await this.claimApproval(id, amount, key);
    if (claim.done) return this.repository.read(id);
    try {
      let lookupOnly = claim.lookupOnly;
      let result = await this.client.toss(id, amount, claim.key, lookupOnly);
      if (!lookupOnly && result.data.code === 'ALREADY_PROCESSED_PAYMENT') {
        lookupOnly = true;
        result = await this.client.toss(id, amount, claim.key, true);
      }
      const p = result.data;
      if (
        result.status === 200 &&
        p.status === 'DONE' &&
        p.orderId === id &&
        p.paymentKey === claim.key &&
        p.totalAmount === amount &&
        p.currency === 'KRW' &&
        typeof p.approvedAt === 'string' &&
        isZonedDate(p.approvedAt)
      ) {
        await this.repository.recordApproval(id, claim.key, p.approvedAt);
        // Commit payment first. The existing PAID worker recovers a later Dver interruption.
        await this.confirmPayment(id, amount, claim.key, requestId, p.approvedAt);
        return this.repository.read(id);
      }
      // An absent lookup cannot prove that an earlier approval failed.
      const declined =
        (!lookupOnly &&
          ((result.status >= 400 && result.status < 500 && p.code === 'REJECT_CARD_PAYMENT') ||
            (result.status === 404 &&
              (p.code === 'NOT_FOUND_PAYMENT' || p.code === 'NOT_FOUND_PAYMENT_SESSION')))) ||
        (lookupOnly &&
          result.status === 200 &&
          (p.status === 'ABORTED' || p.status === 'EXPIRED') &&
          p.orderId === id &&
          p.paymentKey === claim.key &&
          p.totalAmount === amount &&
          p.currency === 'KRW');
      if (declined && (await this.repository.releaseClaim(id, claim.claimId, true))) {
        throw new ApiException(422, 'PAYMENT_FAILED', '결제가 승인되지 않았습니다.');
      }
      throw new ApiException(502, 'PAYMENT_RESULT_UNKNOWN', '결제 결과를 조회로 확인해 주세요.');
    } finally {
      await this.repository.releaseClaim(id, claim.claimId);
    }
  }

  private async claimApproval(id: string, amount: number, key?: string) {
    return this.database.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='2s'");
      const r = await this.repository.request(client, id);
      if (!r || r.order.retentionExpired)
        throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      if (r.amount !== amount || (key && r.providerPaymentKey && r.providerPaymentKey !== key))
        throw new ApiException(409, 'INVALID_STATE', '결제 정보가 일치하지 않습니다.');
      if (r.completedAt) return { done: true as const, claimId: null };
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
        const snapshot = await this.ordersRepository.detail(client, r.orderSeq, null);
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

  private async confirmPayment(
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
        request.invalidatedAt ||
        request.order.status !== 'notPaid' ||
        request.amount !== amount ||
        request.order.totalAmount !== amount
      )
        throw new ApiException(409, 'INVALID_STATE', '결제 승인 대상이 변경되었습니다.');
      await this.repository.complete(client, id, providerReference);
      await this.repository.markPaid(client, request.orderSeq, approvedAt);
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

  async notifyOne() {
    this.ensureEnabled();
    const id = await this.repository.claimNotification();
    if (!id) return false;
    const view = await this.repository.readNotice(id);
    if (view.status !== 'PENDING') {
      await this.repository.finishNotification(id, 'FAILED');
      return true;
    }
    const result = await this.client.notify(
      paymentMessage(view, this.config.get('PAYMENT_PUBLIC_URL', { infer: true })),
    );
    await this.repository.finishNotification(id, result);
    return true;
  }

  async retryNotification(id: string, adminId: number, requestId: string) {
    this.ensureEnabled();
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
    return this.repository.read(id);
  }

  async notifyCompletionOne() {
    this.ensureEnabled();
    const id = await this.repository.claimCompletionNotification();
    if (!id) return false;
    const view = await this.repository.readNotice(id);
    if (view.status !== 'PAID') {
      await this.repository.finishCompletionNotification(id, 'FAILED');
      return true;
    }
    const result = await this.client.notify(
      paymentCompletionMessage(view, this.config.get('PAYMENT_PUBLIC_URL', { infer: true })),
    );
    await this.repository.finishCompletionNotification(id, result);
    return true;
  }

  async retryCompletionNotification(id: string, adminId: number, requestId: string) {
    this.ensureEnabled();
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
    return this.repository.read(id);
  }
}
