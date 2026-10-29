import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { OrderPaymentsRepository } from './order-payments.repository';
import { OrdersService } from './orders.service';

// Internal seam only: a verified payment-provider integration must call these methods.
// No HTTP route accepts an AI/admin claim that a card payment succeeded.
@Injectable()
export class OrderPaymentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: OrderPaymentsRepository,
    private readonly audit: AuditService,
    private readonly orders: OrdersService,
  ) {}
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
  async confirmPayment(id: string, amount: number, providerReference: string, requestId: string) {
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
      await this.repository.billed(client, request.orderSeq, null, null);
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
