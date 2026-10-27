import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { OriginPinDto } from './dto/create-order.dto';
import { CreatedOrderDto, OrderSummaryDto } from './dto/order-response.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { ORDER_ADDRESS_FIELDS, OrderDraft } from './order-draft';

@Injectable()
export class OrdersRepository {
  async readCustomer(client: PoolClient, callId: number) {
    return (
      await client.query<{ customerSeq: number | null; endedAt: Date | null }>(
        `SELECT u.customer_seq AS "customerSeq", c.ended_at AS "endedAt"
         FROM call_sessions c LEFT JOIN customers u
           ON u.phone_number=c.caller_phone_number AND u.status='ACTIVE'
         WHERE c.call_session_seq=$1`,
        [callId],
      )
    ).rows[0];
  }

  async list(client: PoolClient, query: OrderQueryDto, customerId: number | null) {
    return (
      await client.query<OrderSummaryDto>(
        `SELECT o.order_seq AS "orderSeq", o.customer_seq AS "customerSeq", o.status,
          o.payment_method_type AS "paymentMethodType", o.pickup_requested_at AS "pickupRequestedAt",
          o.created_at AS "createdAt",
          (SELECT count(*)::int FROM order_parcels p WHERE p.order_seq=o.order_seq) AS "parcelCount",
          ARRAY(SELECT DISTINCT s.status FROM shipments s
            JOIN order_parcels p ON p.order_parcel_seq=s.order_parcel_seq
            WHERE p.order_seq=o.order_seq ORDER BY s.status) AS "shipmentStatuses"
         FROM orders o
         WHERE ($1::int IS NULL OR o.customer_seq=$1)
           AND ($2::timestamptz IS NULL OR o.created_at >= $2)
           AND ($3::timestamptz IS NULL OR o.created_at < $3)
           AND ($4::text IS NULL OR o.status=$4)
           AND ($5::text IS NULL OR EXISTS(
             SELECT 1 FROM order_parcels p JOIN shipments s ON s.order_parcel_seq=p.order_parcel_seq
             WHERE p.order_seq=o.order_seq AND s.status=$5))
           AND ($6::text IS NULL OR EXISTS(
             SELECT 1 FROM order_parcels p WHERE p.order_seq=o.order_seq
               AND strpos(lower(p.destination_name),lower($6)) > 0))
         ORDER BY o.created_at DESC, o.order_seq DESC LIMIT $7 OFFSET $8`,
        [
          customerId,
          query.from ?? null,
          query.to ?? null,
          query.status ?? null,
          query.shipmentStatus ?? null,
          query.recipientName ?? null,
          query.limit + 1,
          query.offset,
        ],
      )
    ).rows;
  }

  async lockCreation(client: PoolClient, key: string): Promise<boolean> {
    const hash = createHash('sha256').update(`orders.create:${key}`).digest();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired',
      [hash.readInt32BE(0), hash.readInt32BE(4)],
    );
    return result.rows[0].acquired;
  }

  async findCreation(
    client: PoolClient,
    key: string,
    adminId: number | null,
    callId: number | null,
  ) {
    return (
      await client.query<CreatedOrderDto & { allowed: boolean }>(
        `SELECT o.order_seq AS "orderSeq", o.version,
          CASE WHEN $2::int IS NULL THEN EXISTS(
            SELECT 1 FROM call_sessions c WHERE c.call_session_seq=$3 AND c.order_seq=o.order_seq)
          ELSE EXISTS(
            SELECT 1 FROM audit_logs a WHERE a.target_type='ORDER' AND a.target_seq=o.order_seq
              AND a.action='ORDER_CREATED' AND a.result='SUCCESS' AND a.actor_type='ADMIN' AND a.actor_seq=$2)
            AND ($3::int IS NULL OR EXISTS(
              SELECT 1 FROM call_sessions c WHERE c.call_session_seq=$3 AND c.order_seq=o.order_seq))
          END AS allowed
        FROM orders o WHERE o.creation_request_id=$1::uuid`,
        [key, adminId, callId],
      )
    ).rows[0];
  }

  async call(client: PoolClient, id: number) {
    return (
      await client.query<{ orderSeq: number | null; endedAt: Date | null; phone: string | null }>(
        'SELECT order_seq AS "orderSeq", ended_at AS "endedAt", caller_phone_number AS phone FROM call_sessions WHERE call_session_seq=$1 FOR UPDATE',
        [id],
      )
    ).rows[0];
  }

  async linkCall(client: PoolClient, callId: number, orderId: number) {
    await client.query('UPDATE call_sessions SET order_seq=$2 WHERE call_session_seq=$1', [
      callId,
      orderId,
    ]);
  }

  async canUsePin(client: PoolClient, customerId: number, pin: OriginPinDto): Promise<boolean> {
    const result =
      pin.scope === 'PERSONAL'
        ? await client.query(
            `SELECT personal_pin_seq FROM personal_pins
         WHERE personal_pin_seq=$1 AND customer_seq=$2 FOR SHARE`,
            [pin.pinSeq, customerId],
          )
        : await client.query(
            `SELECT p.company_pin_seq FROM company_pins p
         JOIN organizations o ON o.organization_seq=p.organization_seq
         JOIN memberships m ON m.organization_seq=o.organization_seq
         WHERE p.company_pin_seq=$1 AND m.customer_seq=$2 AND m.status='ACTIVE' AND o.status='ACTIVE'
         FOR SHARE OF p,o,m`,
            [pin.pinSeq, customerId],
          );
    return result.rowCount === 1;
  }

  async insert(
    client: PoolClient,
    draft: OrderDraft,
    customerId: number,
    key: string,
  ): Promise<CreatedOrderDto> {
    const id = (
      await client.query<{ id: number }>(
        `INSERT INTO orders(customer_seq,payment_method_type,pickup_requested_at,status,creation_request_id)
       VALUES($1,$2,$3,'COLLECTING',$4::uuid) RETURNING order_seq AS id`,
        [customerId, draft.paymentMethodType, draft.pickupRequestedAt, key],
      )
    ).rows[0].id;
    for (const [index, parcel] of draft.parcels.entries()) {
      await client.query(
        `INSERT INTO order_parcels (
          order_seq,parcel_position,
          origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_detail_address,
          origin_dong_name,origin_postal_code,origin_latitude,origin_longitude,
          destination_name,destination_phone_number,destination_road_address,destination_jibun_address,destination_detail_address,
          destination_dong_name,destination_postal_code,destination_latitude,destination_longitude,
          origin_pin_scope,origin_pin_seq,document_count,small_box_count,medium_box_count,big_box_count,
          other_item_description,client_comment,item_price,notified_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,3500)`,
        [
          id,
          index + 1,
          ...ORDER_ADDRESS_FIELDS.map((field) => parcel.origin[field]),
          ...ORDER_ADDRESS_FIELDS.map((field) => parcel.destination[field]),
          parcel.originPin?.scope ?? null,
          parcel.originPin?.pinSeq ?? null,
          parcel.documentCount,
          parcel.smallBoxCount,
          parcel.mediumBoxCount,
          parcel.bigBoxCount,
          parcel.otherItemDescription,
          parcel.clientComment,
          parcel.itemPrice,
        ],
      );
    }
    // 상세 추가 트리거가 버전을 올리므로 초기값이나 상세 수로 추정하지 않는다.
    return (
      await client.query<CreatedOrderDto>(
        'SELECT order_seq AS "orderSeq",version FROM orders WHERE order_seq=$1',
        [id],
      )
    ).rows[0];
  }
}
