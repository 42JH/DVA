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
  async pendingApprovals() {
    // Schedule before I/O so even unreadable requests yield their place after a failed lookup.
    return (
      await this.database.pool.query<{
        id: string;
      }>(`WITH candidates AS (
      SELECT payment_request_id FROM order_payment_requests
      WHERE provider_payment_key IS NOT NULL AND approval_started_at IS NOT NULL AND invalidated_at IS NULL
      AND completed_at IS NULL AND (approval_claimed_until IS NULL OR approval_claimed_until<=clock_timestamp())
      AND (approval_next_check_at IS NULL OR approval_next_check_at<=clock_timestamp())
      ORDER BY COALESCE(approval_next_check_at,approval_started_at),payment_request_id
      LIMIT 20 FOR UPDATE SKIP LOCKED)
      UPDATE order_payment_requests r SET approval_next_check_at=clock_timestamp()+interval '1 minute'
      FROM candidates c WHERE r.payment_request_id=c.payment_request_id
      RETURNING r.payment_request_id AS id`)
    ).rows;
  }
}
