import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { OrderPaymentsRepository } from './order-payments.repository';
import { OrdersService } from './orders.service';
import { randomUUID } from 'node:crypto';

// Internal domain seam. PaymentsService reserves a durable provider key and lease
// before calling confirmPayment; no route accepts an AI/admin claim of success.
@Injectable()
export class OrderPaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrderPaymentsRepository,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
  ) {}

  async claimApproval(id: string, amount: number, key?: string) {
    return this.database.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='2s'");
      const r = await this.repository.request(client, id);
      if (!r) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
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
      const claimId = randomUUID();
      await this.repository.reserveApproval(client, id, paymentKey, claimId);
      return { done: false as const, key: paymentKey, claimId, lookupOnly: !!r.approvalStartedAt };
    });
  }

  releaseClaim(id: string, claimId: string, declined = false) {
    return this.repository.releaseClaim(id, claimId, declined);
  }

  recordApproval(id: string, key: string, approvedAt: string) {
    return this.repository.recordApproval(id, key, approvedAt);
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
  async beginPayment(id: string, amount: number) {
    return this.database.transaction(async (client) => {
      const request = await this.repository.request(client, id);
      if (!request) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      if (
        request.order.status !== 'notPaid' ||
        request.invalidatedAt ||
        request.completedAt ||
        request.expiresAt.getTime() <= Date.now() ||
        request.order.totalAmount !== amount ||
        request.amount !== amount
      )
        throw new ApiException(409, 'INVALID_STATE', '현재 유효한 금액의 미결제 요청이 아닙니다.');
      if (request.approvalStartedAt)
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '결제 승인 처리 중입니다.');
      await this.repository.begin(client, id);
      return { orderSeq: request.orderSeq, amount: request.amount };
    });
  }
  async releaseDeclinedPayment(id: string) {
    await this.database.transaction(async (client) => {
      const request = await this.repository.request(client, id);
      if (!request) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      await this.repository.release(client, id);
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
        request.invalidatedAt ||
        request.order.status !== 'notPaid' ||
        request.amount !== amount ||
        request.order.totalAmount !== amount
      )
        throw new ApiException(409, 'INVALID_STATE', '결제 승인 대상이 변경되었습니다.');
      await this.repository.complete(client, id, providerReference);
      await this.repository.billed(client, request.orderSeq, null, null, requestId, approvedAt);
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
    return this.orders.submitPaidOrder(orderId, requestId);
  }
}
