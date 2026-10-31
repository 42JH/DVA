import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { OrderPaymentsService } from '../orders/order-payments.service';
import { isZonedDate } from '../orders/order-draft';
import { PaymentsRepository } from './payments.repository';
import { PaymentClient } from './payment.client';
import { paymentCompletionMessage, paymentMessage } from './payment-message';

@Injectable()
export class PaymentsService {
  private readonly active = new Map<string, { key: string; promise: Promise<unknown> }>();
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: PaymentsRepository,
    private readonly client: PaymentClient,
    private readonly orders: OrderPaymentsService,
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
    const claim = await this.orders.claimApproval(id, amount, key);
    if (claim.done) return this.repository.read(id);
    try {
      let result = await this.client.toss(id, amount, claim.key, claim.lookupOnly);
      if (!claim.lookupOnly && result.data.code === 'ALREADY_PROCESSED_PAYMENT')
        result = await this.client.toss(id, amount, claim.key, true);
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
        await this.orders.recordApproval(id, claim.key, p.approvedAt);
        // Commit payment first. The existing PAID worker recovers a later Dver interruption.
        await this.orders.confirmPayment(id, amount, claim.key, requestId, p.approvedAt);
        return this.repository.read(id);
      }
      const declined =
        (!claim.lookupOnly &&
          result.status >= 400 &&
          result.status < 500 &&
          p.code === 'REJECT_CARD_PAYMENT') ||
        (claim.lookupOnly &&
          result.status === 200 &&
          ['ABORTED', 'EXPIRED'].includes(String(p.status)) &&
          p.orderId === id &&
          p.paymentKey === claim.key &&
          p.totalAmount === amount);
      if (declined) {
        await this.orders.releaseClaim(id, claim.claimId!, true);
        throw new ApiException(422, 'PAYMENT_FAILED', '결제가 승인되지 않았습니다.');
      }
      throw new ApiException(502, 'PAYMENT_RESULT_UNKNOWN', '결제 결과를 조회로 확인해 주세요.');
    } finally {
      await this.orders.releaseClaim(id, claim.claimId!);
    }
  }
  async notifyOne() {
    this.ensureEnabled();
    const id = await this.orders.claimNotification();
    if (!id) return false;
    const view = await this.repository.readNotice(id);
    if (view.status !== 'PENDING') {
      await this.orders.finishNotification(id, 'FAILED');
      return true;
    }
    const result = await this.client.notify(
      paymentMessage(view, this.config.get('PAYMENT_PUBLIC_URL', { infer: true })),
    );
    await this.orders.finishNotification(id, result);
    return true;
  }
  async retryNotification(id: string, adminId: number, requestId: string) {
    this.ensureEnabled();
    await this.orders.retryNotification(id, adminId, requestId);
    return this.repository.read(id);
  }
  async notifyCompletionOne() {
    this.ensureEnabled();
    const id = await this.orders.claimCompletionNotification();
    if (!id) return false;
    const view = await this.repository.readNotice(id);
    if (view.status !== 'PAID') {
      await this.orders.finishCompletionNotification(id, 'FAILED');
      return true;
    }
    const result = await this.client.notify(
      paymentCompletionMessage(view, this.config.get('PAYMENT_PUBLIC_URL', { infer: true })),
    );
    await this.orders.finishCompletionNotification(id, result);
    return true;
  }
  async retryCompletionNotification(id: string, adminId: number, requestId: string) {
    this.ensureEnabled();
    await this.orders.retryCompletionNotification(id, adminId, requestId);
    return this.repository.read(id);
  }
}
