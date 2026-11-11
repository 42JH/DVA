import type { PaymentPolicy } from '@dva/events/order-intake-write.cjs';
import type { PoolClient } from 'pg';
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ApiException } from '../common/errors/api.exception';
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
export interface PaymentNoticeParcel {
  senderName: string | null;
  recipientName: string | null;
  originAddress: string;
  destinationAddress: string;
}
export interface PaymentNoticeView extends PaymentView {
  parcels: PaymentNoticeParcel[];
}
export interface PaymentRequest {
  paymentRequestId: string;
  orderSeq: number;
  amount: number;
  expiresAt: Date;
  approvalStartedAt: Date | null;
  invalidatedAt: Date | null;
  completedAt: Date | null;
  providerReference: string | null;
  providerPaymentKey: string | null;
  providerApprovedAt: Date | null;
  approvalClaimId: string | null;
  approvalClaimedUntil: Date | null;
  notificationStatus: string;
}

@Injectable()
export class PaymentsRepository {
  constructor(private readonly database: DatabaseService) {}
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
       FROM order_payment_requests r JOIN orders o USING(order_seq) WHERE r.payment_request_id=$1 AND o.deleted_at IS NULL
         AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years'`,
        [id],
      )
    ).rows[0];
    if (!result) throw new ApiException(404, 'NOT_FOUND', '결제 요청을 찾을 수 없습니다.');
    return result;
  }

  async readNotice(id: string): Promise<PaymentNoticeView> {
    const view = await this.read(id);
    const parcels = (
      await this.database.pool.query<PaymentNoticeParcel>(
        `SELECT origin_name AS "senderName",destination_name AS "recipientName",
        concat_ws(' ',COALESCE(NULLIF(btrim(origin_road_address),''),NULLIF(btrim(origin_jibun_address),'')),
          NULLIF(btrim(origin_detail_address),'')) AS "originAddress",
        concat_ws(' ',COALESCE(NULLIF(btrim(destination_road_address),''),NULLIF(btrim(destination_jibun_address),'')),
          NULLIF(btrim(destination_detail_address),'')) AS "destinationAddress"
        FROM order_parcels WHERE order_seq=$1 AND status='ACTIVE' ORDER BY order_parcel_seq`,
        [view.orderSeq],
      )
    ).rows;
    return { ...view, parcels };
  }

  async request(client: PoolClient, id: string) {
    // All payment/cancellation paths lock the parent before its request.
    const parent = (
      await client.query<{ orderSeq: number }>(
        'SELECT order_seq AS "orderSeq" FROM order_payment_requests WHERE payment_request_id=$1',
        [id],
      )
    ).rows[0];
    if (!parent) return undefined;
    const order = (
      await client.query<{
        status: string;
        totalAmount: number;
        paidAt: Date | null;
        retentionExpired: boolean;
      }>(
        `SELECT status,total_amount AS "totalAmount",paid_at AS "paidAt",
         COALESCE(closed_at,created_at)<=clock_timestamp()-interval '5 years' AS "retentionExpired"
         FROM orders WHERE order_seq=$1 AND deleted_at IS NULL FOR UPDATE`,
        [parent.orderSeq],
      )
    ).rows[0];
    if (!order) return undefined;
    const request = (
      await client.query<PaymentRequest>(
        `SELECT payment_request_id AS "paymentRequestId",order_seq AS "orderSeq",amount,expires_at AS "expiresAt",approval_started_at AS "approvalStartedAt",invalidated_at AS "invalidatedAt",completed_at AS "completedAt",provider_reference AS "providerReference",provider_payment_key AS "providerPaymentKey",provider_approved_at AS "providerApprovedAt",approval_claim_id AS "approvalClaimId",approval_claimed_until AS "approvalClaimedUntil",notification_status AS "notificationStatus" FROM order_payment_requests WHERE payment_request_id=$1 FOR UPDATE`,
        [id],
      )
    ).rows[0];
    return { ...request, order };
  }

  async reserveApproval(client: PoolClient, id: string, key: string, claimId: string) {
    const result = await client.query(
      `UPDATE order_payment_requests SET provider_payment_key=$2,
        approval_started_at=COALESCE(approval_started_at,clock_timestamp()),approval_claim_id=$3,
        approval_claimed_until=clock_timestamp()+interval '45 seconds' WHERE payment_request_id=$1
        AND EXISTS(SELECT 1 FROM orders o WHERE o.order_seq=order_payment_requests.order_seq
          AND o.deleted_at IS NULL AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years')`,
      [id, key, claimId],
    );
    return result.rowCount === 1;
  }

  async markPaid(client: PoolClient, id: number, approvedAt?: string, policy?: PaymentPolicy) {
    await client.query(
      `WITH paid AS (SELECT COALESCE($2::timestamptz,clock_timestamp()) AS at),
       pickup AS (SELECT at,date_trunc('day',at AT TIME ZONE 'Asia/Seoul') AS local_day FROM paid)
       UPDATE orders SET status='PAID',paid_at=pickup.at,pickup_requested_at=CASE
         WHEN pickup_requested_at>=pickup.at THEN pickup_requested_at
         WHEN pickup.at+interval '1 hour'>(pickup.local_day+interval '17 hours') AT TIME ZONE 'Asia/Seoul'
           THEN (pickup.local_day+interval '1 day 9 hours') AT TIME ZONE 'Asia/Seoul'
         ELSE GREATEST(pickup.at+interval '1 hour',(pickup.local_day+interval '9 hours') AT TIME ZONE 'Asia/Seoul') END,
       billing_organization_seq=$3,billing_department_seq=$4,
       billing_organization_name=$5,billing_department_name=$6
       FROM pickup WHERE order_seq=$1`,
      [
        id,
        approvedAt ?? null,
        policy?.organizationSeq ?? null,
        policy?.departmentSeq ?? null,
        policy?.organizationName ?? null,
        policy?.departmentName ?? null,
      ],
    );
  }

  async complete(client: PoolClient, id: string, reference: string) {
    await client.query(
      "UPDATE order_payment_requests SET completed_at=clock_timestamp(),provider_reference=$2,approval_claim_id=NULL,approval_claimed_until=NULL,completion_notification_status='PENDING' WHERE payment_request_id=$1",
      [id, reference],
    );
  }

  async releaseClaim(id: string, claimId: string, declined = false) {
    const result = await this.database.pool.query(
      `UPDATE order_payment_requests SET approval_claim_id=NULL,approval_claimed_until=NULL,
      approval_started_at=CASE WHEN $3 THEN NULL ELSE approval_started_at END,
      provider_payment_key=CASE WHEN $3 THEN NULL ELSE provider_payment_key END,
      approval_next_check_at=CASE WHEN $3 THEN NULL ELSE approval_next_check_at END
      WHERE payment_request_id=$1 AND approval_claim_id=$2 AND completed_at IS NULL
      AND (NOT $3 OR (provider_approved_at IS NULL AND invalidated_at IS NULL
        AND approval_claimed_until>clock_timestamp()))`,
      [id, claimId, declined],
    );
    return result.rowCount === 1;
  }

  async recordApproval(id: string, key: string, approvedAt: string) {
    await this.database.pool.query(
      'UPDATE order_payment_requests SET provider_approved_at=$3 WHERE payment_request_id=$1 AND provider_payment_key=$2',
      [id, key, approvedAt],
    );
  }

  async pendingApprovals() {
    // Schedule before I/O so even unreadable requests yield their place after a failed lookup.
    return (
      await this.database.pool.query<{
        id: string;
      }>(`WITH candidates AS (
      SELECT r.payment_request_id FROM order_payment_requests r JOIN orders o USING(order_seq)
      WHERE r.provider_payment_key IS NOT NULL AND r.approval_started_at IS NOT NULL AND r.invalidated_at IS NULL
      AND r.completed_at IS NULL AND (r.approval_claimed_until IS NULL OR r.approval_claimed_until<=clock_timestamp())
      AND (r.approval_next_check_at IS NULL OR r.approval_next_check_at<=clock_timestamp())
      AND o.deleted_at IS NULL AND COALESCE(o.closed_at,o.created_at)>statement_timestamp()-interval '5 years'
      ORDER BY COALESCE(r.approval_next_check_at,r.approval_started_at),r.payment_request_id
      LIMIT 20 FOR UPDATE OF r SKIP LOCKED)
      UPDATE order_payment_requests r SET approval_next_check_at=clock_timestamp()+interval '1 minute'
      FROM candidates c WHERE r.payment_request_id=c.payment_request_id
      RETURNING r.payment_request_id AS id`)
    ).rows;
  }

  async queueNotification(client: PoolClient, id: string) {
    await client.query(
      "UPDATE order_payment_requests SET notification_status='PENDING',notification_attempted_at=NULL,notification_sent_at=NULL WHERE payment_request_id=$1",
      [id],
    );
  }

  async completionStatus(client: PoolClient, id: string): Promise<string> {
    return (
      await client.query<{ status: string }>(
        'SELECT completion_notification_status AS status FROM order_payment_requests WHERE payment_request_id=$1',
        [id],
      )
    ).rows[0].status;
  }

  async queueCompletionNotification(client: PoolClient, id: string) {
    await client.query(
      `UPDATE order_payment_requests SET completion_notification_status='PENDING',
        completion_notification_attempted_at=NULL,completion_notification_sent_at=NULL WHERE payment_request_id=$1`,
      [id],
    );
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
        AND r.completed_at IS NULL AND r.approval_started_at IS NULL AND r.expires_at>clock_timestamp() AND o.status='notPaid' AND o.deleted_at IS NULL
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
}
