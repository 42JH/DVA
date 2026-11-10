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
}
