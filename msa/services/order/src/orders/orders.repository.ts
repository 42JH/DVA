import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { readPage } from '../common/pagination-query';
import { AdminOrderListItemDto, AdminOrderListQueryDto } from './dto/admin-order-list.dto';
import {
  OrderAddressHistoryQueryDto,
  PreviousOrderAddressDto,
} from './dto/order-address-history.dto';
import { OrderDetailDto, OrderSummaryDto } from './dto/order-response.dto';
import type { OrderStatus } from './orders.types';
import { OrderQueryDto } from './dto/order-query.dto';
const paymentRequestJson = `(SELECT jsonb_build_object('paymentRequestId',r.payment_request_id,'amount',r.amount,'expiresAt',r.expires_at,'notificationStatus',r.notification_status)
 FROM order_payment_requests r WHERE r.order_seq=o.order_seq AND r.invalidated_at IS NULL AND r.completed_at IS NULL AND r.expires_at>clock_timestamp())`;

@Injectable()
export class OrdersRepository {
  async paymentDeletionBlocked(client: PoolClient, id: number): Promise<boolean> {
    const requests = await client.query<{ blocked: boolean }>(
      `SELECT ((approval_started_at IS NOT NULL AND completed_at IS NULL AND invalidated_at IS NULL)
        OR notification_status='SENDING' OR completion_notification_status='SENDING') AS blocked
       FROM order_payment_requests WHERE order_seq=$1 ORDER BY payment_request_id FOR UPDATE`,
      [id],
    );
    return requests.rows.some((row) => row.blocked);
  }

  async softDelete(client: PoolClient, id: number): Promise<void> {
    await client.query(
      `UPDATE order_payment_requests SET
      notification_status=CASE WHEN notification_status='PENDING' THEN 'FAILED' ELSE notification_status END,
      completion_notification_status=CASE WHEN completion_notification_status IN ('WAITING','PENDING') THEN 'FAILED' ELSE completion_notification_status END
      WHERE order_seq=$1`,
      [id],
    );
    await client.query('UPDATE orders SET deleted_at=clock_timestamp() WHERE order_seq=$1', [id]);
  }

  async lockOrder(client: PoolClient, id: number) {
    return (
      await client.query<{
        customerSeq: number | null;
        status: OrderStatus;
        version: number;
        totalAmount: number | null;
        paymentMethodType: string | null;
      }>(
        'SELECT customer_seq AS "customerSeq",status,version,total_amount AS "totalAmount",payment_method_type AS "paymentMethodType" FROM orders WHERE order_seq=$1 AND deleted_at IS NULL AND COALESCE(closed_at,created_at)>clock_timestamp()-interval \'5 years\' FOR UPDATE',
        [id],
      )
    ).rows[0];
  }

  async addressHistory(client: PoolClient, customerId: number, query: OrderAddressHistoryQueryDto) {
    // SQL 식별자는 검증된 두 방향의 상수에서만 선택한다. 검색값은 모두 바인딩한다.
    const side = query.direction === 'ORIGIN' ? 'origin' : 'destination';
    const page = await readPage<PreviousOrderAddressDto & { __sort_position: number }>(
      client,
      `SELECT o.order_seq AS "orderSeq",p.order_parcel_seq AS "orderParcelSeq",o.created_at AS "createdAt",p.parcel_position AS __sort_position,
        jsonb_build_object('name',p.${side}_name,'phoneNumber',p.${side}_phone_number,
          'roadAddress',p.${side}_road_address,'jibunAddress',p.${side}_jibun_address,
          'detailAddress',p.${side}_detail_address,'dongName',p.${side}_dong_name,
          'postalCode',p.${side}_postal_code) AS address
       FROM orders o JOIN order_parcels p ON p.order_seq=o.order_seq
       WHERE o.customer_seq=$1 AND o.status='ACCEPTED' AND p.status='ACTIVE' AND o.deleted_at IS NULL
         AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years'
         AND ($2::timestamptz IS NULL OR o.created_at >= $2)
         AND ($3::timestamptz IS NULL OR o.created_at < $3)
         AND (NULLIF(btrim(p.${side}_road_address),'') IS NOT NULL
           OR NULLIF(btrim(p.${side}_jibun_address),'') IS NOT NULL)
         AND ($4::text IS NULL OR strpos(lower(normalize(concat_ws(' ',
           p.${side}_name,p.${side}_phone_number,p.${side}_road_address,p.${side}_jibun_address,
           p.${side}_detail_address,p.${side}_dong_name,p.${side}_postal_code),NFC)),lower(normalize($4,NFC)))>0)`,
      [customerId, query.from ?? null, query.to ?? null, query.q || null],
      query,
      '"createdAt" DESC,"orderSeq" DESC,__sort_position,"orderParcelSeq"',
    );
    return {
      ...page,
      rows: page.rows.map((row) => {
        const address: PreviousOrderAddressDto & { __sort_position?: number } = { ...row };
        delete address.__sort_position;
        return address;
      }),
    };
  }

  async adminList(client: Pool | PoolClient, query: AdminOrderListQueryDto) {
    const phoneQuery =
      query.q && /^[0-9+() -]+$/.test(query.q) ? query.q.replace(/[^0-9]/g, '') : null;
    return readPage<AdminOrderListItemDto>(
      client,
      `SELECT o.order_seq AS "orderSeq",o.status,o.created_at AS "createdAt",o.pickup_requested_at AS "pickupRequestedAt",
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'orderParcelSeq',p.order_parcel_seq,'status',p.status,
         'origin',jsonb_build_object('name',p.origin_name,'phoneNumber',p.origin_phone_number,'roadAddress',p.origin_road_address,'jibunAddress',p.origin_jibun_address,'detailAddress',p.origin_detail_address),
         'destination',jsonb_build_object('name',p.destination_name,'phoneNumber',p.destination_phone_number,'roadAddress',p.destination_road_address,'jibunAddress',p.destination_jibun_address,'detailAddress',p.destination_detail_address),
         'documentCount',p.document_count,'smallBoxCount',p.small_box_count,'mediumBoxCount',p.medium_box_count,'bigBoxCount',p.big_box_count,'otherItemDescription',p.other_item_description)
         ORDER BY p.parcel_position,p.order_parcel_seq) FROM order_parcels p WHERE p.order_seq=o.order_seq),'[]'::jsonb) AS parcels
       FROM orders o
       WHERE o.deleted_at IS NULL AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years'
        AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM order_parcels p WHERE p.order_seq=o.order_seq AND (
         EXISTS(SELECT 1 FROM unnest(ARRAY[p.origin_name,p.origin_phone_number,p.origin_road_address,p.origin_jibun_address,p.origin_detail_address,
           p.destination_name,p.destination_phone_number,p.destination_road_address,p.destination_jibun_address,p.destination_detail_address]) AS v(value)
           WHERE strpos(lower(normalize(v.value,NFC)),lower($1))>0)
         OR ($5::text IS NOT NULL AND (strpos(p.origin_phone_number,$5)>0 OR strpos(p.destination_phone_number,$5)>0)))))
        AND ($2::timestamptz IS NULL OR o.created_at >= $2)
        AND ($3::timestamptz IS NULL OR o.created_at < $3)
        AND ($4::text IS NULL OR o.status=$4 OR ($4='PAID' AND o.status IN ('SUBMITTING','ACCEPTED'))
         OR ($4='SUBMISSION_FAILED' AND o.status='SUBMITTING_FAILED'))`,
      [
        query.q || null,
        query.from ?? null,
        query.to ?? null,
        query.statusGroup ?? null,
        phoneQuery || null,
      ],
      query,
      '"createdAt" DESC,"orderSeq" DESC',
    );
  }

  async list(client: PoolClient, query: OrderQueryDto, customerId: number | null) {
    return await readPage<OrderSummaryDto>(
      client,
      `SELECT o.order_seq AS "orderSeq", o.customer_seq AS "customerSeq", o.status,
          o.creation_source AS "creationSource",o.total_amount AS "totalAmount",o.payment_due_at AS "paymentDueAt",o.paid_at AS "paidAt",
          o.payment_method_type AS "paymentMethodType", o.pickup_requested_at AS "pickupRequestedAt",
          o.created_at AS "createdAt",
          (SELECT count(*)::int FROM order_parcels p WHERE p.order_seq=o.order_seq) AS "parcelCount"
         FROM orders o
         WHERE o.deleted_at IS NULL AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years'
           AND ($1::int IS NULL OR o.customer_seq=$1)
           AND ($2::timestamptz IS NULL OR o.created_at >= $2)
           AND ($3::timestamptz IS NULL OR o.created_at < $3)
           AND ($4::text IS NULL OR o.status=$4)
           AND ($5::text IS NULL OR EXISTS(
             SELECT 1 FROM order_parcels p WHERE p.order_seq=o.order_seq
               AND strpos(lower(p.destination_name),lower($5)) > 0))`,
      [
        customerId,
        query.from ?? null,
        query.to ?? null,
        query.status ?? null,
        query.recipientName ?? null,
      ],
      query,
      '"createdAt" DESC,"orderSeq" DESC',
    );
  }

  async detail(client: PoolClient, id: number, customerId: number | null) {
    return (
      await client.query<{ detail: OrderDetailDto }>(
        `SELECT jsonb_build_object(
          'orderSeq',o.order_seq,'customerSeq',o.customer_seq,'status',o.status,
          'creationSource',o.creation_source,'totalAmount',o.total_amount,'paidAt',o.paid_at,
          'paymentDueAt',o.payment_due_at,'paymentRequest',${paymentRequestJson},
          'paymentMethodType',o.payment_method_type,'pickupRequestedAt',o.pickup_requested_at,
           'billingOrganizationSeq',o.billing_organization_seq,'billingOrganizationName',o.billing_organization_name,
           'billingDepartmentSeq',o.billing_department_seq,'billingDepartmentName',o.billing_department_name,
          'createdAt',o.created_at,'updatedAt',o.updated_at,'version',o.version,
          'parcelNo',o.parcel_no,'dverReceivedAt',o.dver_received_at,
          'parcels',COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
              'orderParcelSeq',p.order_parcel_seq,'orderSeq',p.order_seq,'parcelPosition',p.parcel_position,'status',p.status,
              'origin',jsonb_build_object(
                'name',p.origin_name,'phoneNumber',p.origin_phone_number,
                'roadAddress',p.origin_road_address,'jibunAddress',p.origin_jibun_address,
                'detailAddress',p.origin_detail_address,'dongName',p.origin_dong_name,
                'postalCode',p.origin_postal_code),
              'destination',jsonb_build_object(
                'name',p.destination_name,'phoneNumber',p.destination_phone_number,
                'roadAddress',p.destination_road_address,'jibunAddress',p.destination_jibun_address,
                'detailAddress',p.destination_detail_address,'dongName',p.destination_dong_name,
                'postalCode',p.destination_postal_code),
              'originPin',CASE WHEN p.origin_pin_seq IS NULL THEN NULL
                ELSE jsonb_build_object('scope',p.origin_pin_scope,'pinSeq',p.origin_pin_seq) END,
              'documentCount',p.document_count,'smallBoxCount',p.small_box_count,
              'mediumBoxCount',p.medium_box_count,'bigBoxCount',p.big_box_count,
              'otherItemDescription',p.other_item_description,'clientComment',p.client_comment,
              'notifiedPrice',p.notified_price,'itemPrice',p.item_price
            ) ORDER BY p.parcel_position)
            FROM order_parcels p
            WHERE p.order_seq=o.order_seq
          ),'[]'::jsonb)
        ) AS detail FROM orders o
        WHERE o.order_seq=$1 AND o.deleted_at IS NULL AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years'
          AND ($2::int IS NULL OR o.customer_seq=$2)`,
        [id, customerId],
      )
    ).rows[0]?.detail;
  }
}
