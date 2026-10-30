import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { OrderPaymentsRepository } from '../orders/order-payments.repository';
import { ApiException } from '../common/errors/api.exception';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';

export interface PaymentView {
  token: string;
  orderId: string;
  orderSeq: number;
  orderName: string;
  amount: number;
  senderName: string;
  recipientSummary: string;
  parcelCount: number;
  pickupRequestedAt: string | null;
  approvedAt: string | null;
  expiresAt: string;
  status: string;
  orderStatus: string;
  notificationStatus: string;
  completionNotificationStatus: string;
}
@Injectable()
export class PaymentsRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly payments: OrderPaymentsRepository,
    private readonly audit: AuditService,
  ) {}
  async read(id: string): Promise<PaymentView> {
    const result = (
      await this.database.pool.query<PaymentView>(
        `SELECT r.payment_request_id AS token,r.payment_request_id AS "orderId",r.order_seq AS "orderSeq",
       'DVA 택배 결제' AS "orderName",r.amount,o.status AS "orderStatus",
       CASE WHEN r.completed_at IS NOT NULL THEN 'PAID'
        WHEN r.invalidated_at IS NOT NULL OR o.status='CANCELLED' THEN 'CANCELLED'
        WHEN r.approval_started_at IS NOT NULL THEN 'REVIEW_REQUIRED'
        WHEN r.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'PENDING' END AS status,
       r.notification_status AS "notificationStatus",r.completion_notification_status AS "completionNotificationStatus",r.expires_at AS "expiresAt",
       o.pickup_requested_at AS "pickupRequestedAt",o.paid_at AS "approvedAt",
       (SELECT p.origin_name FROM order_parcels p WHERE p.order_seq=o.order_seq AND p.status='ACTIVE' ORDER BY p.order_parcel_seq LIMIT 1) AS "senderName",
       (SELECT p.destination_name FROM order_parcels p WHERE p.order_seq=o.order_seq AND p.status='ACTIVE' ORDER BY p.order_parcel_seq LIMIT 1) AS "recipientSummary",
       (SELECT count(*)::int FROM order_parcels p WHERE p.order_seq=o.order_seq AND p.status='ACTIVE') AS "parcelCount"
       FROM order_payment_requests r JOIN orders o USING(order_seq) WHERE r.payment_request_id=$1`,
        [id],
      )
    ).rows[0];
    if (!result) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
    return result;
  }
  async claim(id: string, amount: number, key?: string) {
    return this.database.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='2s'");
      const r = await this.payments.request(client, id);
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
      await client.query(
        `UPDATE order_payment_requests SET provider_payment_key=$2,
        approval_started_at=COALESCE(approval_started_at,clock_timestamp()),approval_claim_id=$3,
        approval_claimed_until=clock_timestamp()+interval '45 seconds' WHERE payment_request_id=$1`,
        [id, paymentKey, claimId],
      );
      return { done: false as const, key: paymentKey, claimId, lookupOnly: !!r.approvalStartedAt };
    });
  }
  async releaseClaim(id: string, claimId: string, declined = false) {
    await this.database.pool.query(
      `UPDATE order_payment_requests SET approval_claim_id=NULL,approval_claimed_until=NULL,
      approval_started_at=CASE WHEN $3 THEN NULL ELSE approval_started_at END,
      provider_payment_key=CASE WHEN $3 THEN NULL ELSE provider_payment_key END
      WHERE payment_request_id=$1 AND approval_claim_id=$2 AND completed_at IS NULL`,
      [id, claimId, declined],
    );
  }
  async recordApproval(id: string, key: string, approvedAt: string) {
    await this.database.pool.query(
      'UPDATE order_payment_requests SET provider_approved_at=$3 WHERE payment_request_id=$1 AND provider_payment_key=$2',
      [id, key, approvedAt],
    );
  }
  async pendingApprovals() {
    return (
      await this.database.pool.query<{
        id: string;
      }>(`SELECT payment_request_id AS id FROM order_payment_requests
      WHERE provider_payment_key IS NOT NULL AND approval_started_at IS NOT NULL AND invalidated_at IS NULL
      AND completed_at IS NULL AND (approval_claimed_until IS NULL OR approval_claimed_until<=clock_timestamp())
      ORDER BY approval_started_at LIMIT 20`)
    ).rows;
  }
  async claimNotification() {
    return this.database.transaction(async (client) => {
      await client.query(`UPDATE order_payment_requests SET notification_status='UNKNOWN'
        WHERE notification_status='SENDING' AND notification_attempted_at<clock_timestamp()-interval '45 seconds'`);
      const row = (
        await client.query<{
          id: string;
        }>(`SELECT r.payment_request_id AS id FROM order_payment_requests r
        JOIN orders o USING(order_seq) WHERE r.notification_status='PENDING' AND r.invalidated_at IS NULL
        AND r.completed_at IS NULL AND r.approval_started_at IS NULL AND r.expires_at>clock_timestamp() AND o.status='notPaid'
        ORDER BY r.created_at LIMIT 1 FOR UPDATE OF r SKIP LOCKED`)
      ).rows[0];
      if (!row) return;
      await client.query(
        `UPDATE order_payment_requests SET notification_status='SENDING',notification_attempted_at=clock_timestamp() WHERE payment_request_id=$1`,
        [row.id],
      );
      return row.id;
    });
  }
  async finishNotification(id: string, status: string) {
    await this.database.pool.query(
      `UPDATE order_payment_requests SET notification_status=$2,
      notification_sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END
      WHERE payment_request_id=$1 AND notification_status='SENDING'`,
      [id, status],
    );
  }
  async retryNotification(id: string, adminId: number, requestId: string) {
    await this.database.transaction(async (client) => {
      const r = await this.payments.request(client, id);
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
      await client.query(
        "UPDATE order_payment_requests SET notification_status='PENDING',notification_attempted_at=NULL,notification_sent_at=NULL WHERE payment_request_id=$1",
        [id],
      );
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
    return this.read(id);
  }
  async claimCompletionNotification() {
    return this.database.transaction(async (client) => {
      await client.query(`UPDATE order_payment_requests SET completion_notification_status='UNKNOWN'
        WHERE completion_notification_status='SENDING'
        AND completion_notification_attempted_at<clock_timestamp()-interval '45 seconds'`);
      const row = (
        await client.query<{
          id: string;
        }>(`SELECT payment_request_id AS id FROM order_payment_requests
        WHERE completion_notification_status IN ('WAITING','PENDING') AND completed_at IS NOT NULL
        ORDER BY completed_at LIMIT 1 FOR UPDATE SKIP LOCKED`)
      ).rows[0];
      if (!row) return;
      await client.query(
        `UPDATE order_payment_requests SET completion_notification_status='SENDING',
        completion_notification_attempted_at=clock_timestamp() WHERE payment_request_id=$1`,
        [row.id],
      );
      return row.id;
    });
  }
  async finishCompletionNotification(id: string, status: string) {
    await this.database.pool.query(
      `UPDATE order_payment_requests SET completion_notification_status=$2,
      completion_notification_sent_at=CASE WHEN $2='SENT' THEN clock_timestamp() ELSE NULL END
      WHERE payment_request_id=$1 AND completion_notification_status='SENDING'`,
      [id, status],
    );
  }
  async retryCompletionNotification(id: string, adminId: number, requestId: string) {
    await this.database.transaction(async (client) => {
      const r = await this.payments.request(client, id);
      if (!r) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
      const row = (
        await client.query<{ status: string }>(
          'SELECT completion_notification_status AS status FROM order_payment_requests WHERE payment_request_id=$1',
          [id],
        )
      ).rows[0];
      if (!r.completedAt || row.status === 'SENDING')
        throw new ApiException(
          409,
          'INVALID_STATE',
          '결제 완료 후 발송 중이 아닐 때만 재발송할 수 있습니다.',
        );
      if (['WAITING', 'PENDING'].includes(row.status)) return;
      await client.query(
        `UPDATE order_payment_requests SET completion_notification_status='PENDING',
        completion_notification_attempted_at=NULL,completion_notification_sent_at=NULL WHERE payment_request_id=$1`,
        [id],
      );
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
    return this.read(id);
  }
}
