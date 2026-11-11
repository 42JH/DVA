import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/errors/api.exception';
import { CardProviderClient } from '../payments/card-provider.client';
import { OrderPaymentsService } from './order-payments.service';
import { OrderPaymentsRepository } from './order-payments.repository';
import { isZonedDate } from './order-draft';

@Injectable()
export class OrderCardPaymentsService {
  private readonly logger = new Logger(OrderCardPaymentsService.name);
  constructor(
    private readonly orders: OrderPaymentsService,
    private readonly cardProvider: CardProviderClient,
    private readonly repository: OrderPaymentsRepository,
    private readonly config: ConfigService,
  ) {}
  async forOrder(id: number, requestId: string) {
    if (!this.config.get('ORDER_PAYMENTS_ENABLED')) return;
    const request = await this.repository.pendingCardForOrder(id);
    if (!request) return;
    try {
      return await this.process(request.id, requestId);
    } catch {
      this.logger.warn({ event: 'card_payment_deferred', orderSeq: id });
    }
  }
  async process(id: string, requestId: string) {
    const claim = await this.orders.claimCardApproval(id);
    if (claim.done) return;
    try {
      const response = claim.lookupOnly
        ? await this.cardProvider.lookup(claim.orderId)
        : await this.cardProvider.approve(
            claim.orderId,
            claim.amount,
            claim.billingKey!,
            claim.card!.providerCustomerKey,
          );
      const p = response.data;
      if (
        response.status === 200 &&
        p.status === 'DONE' &&
        p.orderId === claim.orderId &&
        p.totalAmount === claim.amount &&
        p.currency === 'KRW' &&
        typeof p.paymentKey === 'string' &&
        p.paymentKey.length > 0 &&
        p.paymentKey.length <= 200 &&
        typeof p.approvedAt === 'string' &&
        isZonedDate(p.approvedAt)
      ) {
        await this.orders.recordCardApproval(id, p.paymentKey, p.approvedAt);
        return this.orders.confirmPayment(id, claim.amount, p.paymentKey, requestId, p.approvedAt);
      }
      if (
        !claim.lookupOnly &&
        response.status >= 400 &&
        response.status < 500 &&
        ![401, 403, 408, 409, 429].includes(response.status)
      ) {
        await this.orders.failCardApproval(id, claim.claimId);
        throw new ApiException(422, 'PAYMENT_FAILED', '등록 카드 결제가 승인되지 않았습니다.');
      }
      throw new ApiException(
        502,
        'PAYMENT_RESULT_UNKNOWN',
        '기존 카드 거래의 결과를 확인해 주세요.',
      );
    } finally {
      await this.orders.releaseClaim(id, claim.claimId);
    }
  }
}
