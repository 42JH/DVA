import { Injectable, Logger } from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { PaymentsRepository } from './payments.repository';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { PaymentClient } from './payment.client';
import { createDecipheriv, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ReadScopes } from '@dva/events/read-scope.cjs';
import {
  requestCardApprovalScope,
  type CardApprovalScopeEvent,
  type StoredPaymentCard,
} from '@dva/events/parcel-draft-write.cjs';
import {
  ParcelDraftWriteScope,
  type CustomerReferenceScope,
} from '../orders/parcel-draft-write-scope.service';
import { isZonedDate } from '../orders/order-draft';
import { orderItemPriceError } from '../orders/order-pricing';
import { OrdersRepository } from '../orders/orders.repository';
import { OrderSubmissionService } from '../orders/order-submission.service';
import { paymentCompletionMessage, paymentMessage } from './payment-message';

type CardApprovalClaim =
  | { done: true }
  | {
      done: false;
      amount: number;
      orderId: string;
      lookupOnly: boolean;
      card: StoredPaymentCard | undefined;
      billingKey: string | undefined;
      claimId: string;
    };

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly active = new Map<string, { key: string; promise: Promise<unknown> }>();
  private readonly cardScopes = new ReadScopes<{
    id: string;
    prepare: (scope: CustomerReferenceScope) => Promise<void>;
  }>(
    () =>
      new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '서비스를 일시적으로 사용할 수 없습니다.'),
  );
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly repository: PaymentsRepository,
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly client: PaymentClient,
    private readonly ordersRepository: OrdersRepository,
    private readonly submissions: OrderSubmissionService,
    private readonly billing: BillingService,
    private readonly scope: ParcelDraftWriteScope,
  ) {}

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

  async claimCardApproval(id: string): Promise<CardApprovalClaim> {
    const existing = await this.database.transaction((client) =>
      this.prepareCardApproval(client, id),
    );
    if (existing) return existing;
    let claim: CardApprovalClaim | undefined;
    let pending: Promise<void> | undefined;
    const scopeId = randomUUID();
    await this.cardScopes.run(
      scopeId,
      {
        id,
        prepare: (owner) => {
          if (!pending)
            pending = this.database
              .transaction((client) => this.prepareCardApproval(client, id, owner))
              .then((prepared) => {
                claim = prepared;
              });
          return pending;
        },
      },
      () =>
        requestCardApprovalScope(
          this.config.get('CUSTOMER_URL', { infer: true }) +
            '/internal/call-read-references/parcel-draft-write/card-approval',
          this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
          {
            eventId: scopeId,
            source: 'order',
            eventType: 'OrderCardApprovalRequested',
            payload: {
              paymentRequestId: id,
              orderAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
            },
          },
        ).catch((error: unknown) => this.scope.failure(error)),
    );
    if (!claim)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    return claim;
  }

  cardApprovalScope(event: CardApprovalScopeEvent) {
    return this.cardScopes.use(event.eventId, async (state) => {
      if (state.id !== event.payload.paymentRequestId)
        throw new ApiException(403, 'FORBIDDEN', '카드 결제 요청 범위를 확인해 주세요.');
      await state.prepare({ id: event.eventId, address: event.payload.customerAddress ?? null });
      return { eventId: event.eventId, status: 'processed', payload: true };
    });
  }

  private async prepareCardApproval(
    client: PoolClient,
    id: string,
    owner?: CustomerReferenceScope,
  ): Promise<CardApprovalClaim | undefined> {
    await client.query("SET LOCAL lock_timeout='2s'");
    const request = await this.repository.request(client, id);
    if (!request || request.order.retentionExpired)
      throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
    if (request.completedAt) return { done: true };
    if (
      !request.paymentCardSeq ||
      request.invalidatedAt ||
      request.order.status !== 'notPaid' ||
      request.amount !== request.order.totalAmount ||
      (!request.approvalStartedAt && request.expiresAt.getTime() <= Date.now())
    )
      throw new ApiException(409, 'INVALID_STATE', '유효한 등록 카드 결제 요청이 아닙니다.');
    if (request.approvalClaimedUntil && request.approvalClaimedUntil.getTime() > Date.now())
      throw new ApiException(409, 'REQUEST_IN_PROGRESS', '카드 승인 결과를 확인 중입니다.');
    let card: StoredPaymentCard | undefined;
    if (!request.approvalStartedAt) {
      if (request.order.customerSeq === null)
        throw new ApiException(403, 'FORBIDDEN', '현재 고객의 카드 결제 자격이 없습니다.');
      if (!owner) return;
      const policy = await this.scope.paymentPolicy(request.order.customerSeq, owner);
      const customer = await this.scope.orderCustomer(request.order.customerSeq, owner);
      if (
        !customer?.active ||
        (request.order.paymentMethodType === 'groupBilling' &&
          (!policy.group || policy.organizationSeq !== request.order.billingOrganizationSeq))
      )
        throw new ApiException(403, 'FORBIDDEN', '현재 고객의 카드 결제 자격이 없습니다.');
      card =
        request.order.paymentMethodType === 'billing' ||
        request.order.paymentMethodType === 'groupBilling'
          ? ((await this.scope.approvalCard(
              request.order.paymentMethodType === 'billing' ? request.order.customerSeq : null,
              request.order.paymentMethodType === 'groupBilling'
                ? request.order.billingOrganizationSeq
                : null,
              owner,
            )) ?? undefined)
          : undefined;
      if (!card || (request.cardPaymentFailed && card.paymentCardSeq === request.paymentCardSeq))
        throw new ApiException(409, 'INVALID_STATE', '결제 카드가 변경되었습니다.');
      if (card.paymentCardSeq !== request.paymentCardSeq) {
        const orderId = randomUUID();
        await this.repository.retryCard(client, id, card.paymentCardSeq, orderId);
        request.paymentCardSeq = card.paymentCardSeq;
        request.cardPaymentOrderId = orderId;
      }
      const snapshot = await this.ordersRepository.detail(client, request.orderSeq, null);
      if (!snapshot) throw new ApiException(404, 'NOT_FOUND', '주문을 찾을 수 없습니다.');
      const errors = snapshot.parcels.flatMap((parcel, index) => {
        const reason = parcel.status !== 'CANCELLED' && orderItemPriceError(parcel.itemPrice);
        return reason ? [{ field: `parcels.${index}.itemPrice`, reason }] : [];
      });
      if (errors.length)
        throw new ApiException(422, 'VALIDATION_FAILED', '물품가액을 확인해 주세요.', errors);
    }
    const claimId = randomUUID();
    const billingKey = card ? this.decryptCard(card) : undefined;
    await this.repository.reserveCardApproval(client, id, claimId);
    return {
      done: false,
      amount: request.amount,
      orderId: request.cardPaymentOrderId,
      lookupOnly: !!request.approvalStartedAt,
      card,
      billingKey,
      claimId,
    };
  }

  private decryptCard(card: StoredPaymentCard) {
    const secret = this.config.get('TOSS_BILLING_SECRET_KEY', { infer: true });
    if (!secret)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '카드 자동결제 연동이 설정되지 않았습니다.',
      );
    if (
      card.providerEnvironment !== (secret.startsWith('live_') ? 'live' : 'test') ||
      !card.encryptedBillingKey
    )
      throw new ApiException(409, 'INVALID_STATE', '현재 결제 환경에서 사용할 수 없는 카드입니다.');
    const encryption = this.config.get('PAYMENT_CARD_ENCRYPTION_KEY', { infer: true });
    if (!encryption)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '카드 저장 암호화가 설정되지 않았습니다.',
      );
    try {
      const bytes = Buffer.from(card.encryptedBillingKey, 'base64');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        Buffer.from(encryption, 'hex'),
        bytes.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from(String(card.paymentCardSeq)));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '등록 카드의 암호화 설정을 확인해 주세요.',
      );
    }
  }

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
    try {
      const view = await this.read(id);
      if (view.autoCharge) return await this.processCard(id, requestId);
      return await this.process(id, view.amount, undefined, requestId, 'ORDER_PAYMENT_RECONCILED');
    } catch (error: unknown) {
      await this.recordPaymentFailure(id, requestId, error, 'ORDER_PAYMENT_RECONCILED');
      throw error;
    }
  }

  async forOrder(id: number, requestId: string) {
    if (!this.config.get('ORDER_PAYMENTS_ENABLED', { infer: true })) return;
    const request = await this.repository.pendingCardForOrder(id);
    if (!request) return;
    try {
      return await this.approveCard(request.id, requestId);
    } catch {
      this.logger.warn({ event: 'card_payment_deferred', orderSeq: id });
    }
  }

  async processCard(id: string, requestId: string) {
    this.ensureEnabled();
    await this.approveCard(id, requestId);
    return this.repository.read(id);
  }

  private async approveCard(id: string, requestId: string) {
    try {
      return await this.approveCardResult(id, requestId);
    } catch (error: unknown) {
      await this.recordPaymentFailure(id, requestId, error, 'ORDER_CARD_PAYMENT');
      throw error;
    }
  }
  private async approveCardResult(id: string, requestId: string) {
    const claim = await this.claimCardApproval(id);
    if (claim.done) return;
    try {
      const response = claim.lookupOnly
        ? await this.client.cardLookup(claim.orderId)
        : await this.client.cardApprove(
            claim.orderId,
            claim.amount,
            claim.billingKey!,
            claim.card!.providerCustomerKey,
          );
      const payment = response.data;
      if (
        response.status === 200 &&
        payment.status === 'DONE' &&
        payment.orderId === claim.orderId &&
        payment.totalAmount === claim.amount &&
        payment.currency === 'KRW' &&
        typeof payment.paymentKey === 'string' &&
        payment.paymentKey.length > 0 &&
        payment.paymentKey.length <= 200 &&
        typeof payment.approvedAt === 'string' &&
        isZonedDate(payment.approvedAt)
      ) {
        await this.repository.recordCardApproval(id, payment.paymentKey, payment.approvedAt);
        return this.confirmPayment(
          id,
          claim.amount,
          payment.paymentKey,
          requestId,
          payment.approvedAt,
        );
      }
      if (
        !claim.lookupOnly &&
        response.status >= 400 &&
        response.status < 500 &&
        ![401, 403, 408, 409, 429].includes(response.status)
      ) {
        await this.repository.failCardApproval(id, claim.claimId);
        throw new ApiException(422, 'PAYMENT_FAILED', '등록 카드 결제가 승인되지 않았습니다.');
      }
      throw new ApiException(
        502,
        'PAYMENT_RESULT_UNKNOWN',
        '기존 카드 거래의 결과를 확인해 주세요.',
      );
    } finally {
      await this.repository.releaseClaim(id, claim.claimId);
    }
  }
  private async process(
    id: string,
    amount: number,
    key: string | undefined,
    requestId: string,
    action:
      'ORDER_PAYMENT_CONFIRMATION' | 'ORDER_PAYMENT_RECONCILED' = 'ORDER_PAYMENT_CONFIRMATION',
  ) {
    try {
      return await this.processApproval(id, amount, key, requestId);
    } catch (error: unknown) {
      await this.recordPaymentFailure(id, requestId, error, action);
      throw error;
    }
  }

  private async processApproval(
    id: string,
    amount: number,
    key: string | undefined,
    requestId: string,
  ) {
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
      if (r.paymentCardSeq !== null)
        throw new ApiException(
          409,
          'INVALID_STATE',
          '등록 카드 결제는 기존 거래 결과를 확인해 주세요.',
        );
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
        (request.paymentCardSeq !== null && request.providerPaymentKey !== providerReference) ||
        request.invalidatedAt ||
        request.order.status !== 'notPaid' ||
        request.amount !== amount ||
        request.order.totalAmount !== amount
      )
        throw new ApiException(409, 'INVALID_STATE', '결제 승인 대상이 변경되었습니다.');
      await this.repository.complete(client, id, providerReference);
      const snapshot =
        request.order.paymentMethodType === 'groupBilling'
          ? await this.scope.billingSnapshot(
              request.order.billingOrganizationSeq,
              request.order.billingDepartmentSeq,
            )
          : undefined;
      await this.repository.markPaid(client, request.orderSeq, approvedAt, snapshot);
      await this.billing.recordCharge(client, request.orderSeq, requestId);
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
