import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { PaymentsRepository } from './payments.repository';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { PaymentClient } from './payment.client';
import { paymentCompletionMessage, paymentMessage } from './payment-message';
@Injectable()
export class PaymentsService {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: PaymentsRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly client: PaymentClient,
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
