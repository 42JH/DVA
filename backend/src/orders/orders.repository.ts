import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { OriginPinDto } from './dto/create-order.dto';
import { CreatedOrderDto } from './dto/order-response.dto';
import { ORDER_ADDRESS_FIELDS, OrderDraft } from './order-draft';

@Injectable()
export class OrdersRepository {
  async lockCreation(client: PoolClient, adminId: number, key: string): Promise<boolean> {
    const hash = createHash('sha256').update(`orders.create:${adminId}:${key}`).digest();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired',
      [hash.readInt32BE(0), hash.readInt32BE(4)],
    );
    return result.rows[0].acquired;
  }

  async findCreation(client: PoolClient, adminId: number, key: string) {
    return (
      await client.query<CreatedOrderDto & { requestHash: string }>(
        `SELECT request_hash AS "requestHash", order_seq AS "orderSeq", response_version AS version
       FROM api_idempotency.order_creations WHERE admin_user_seq=$1 AND idempotency_key=$2::uuid`,
        [adminId, key],
      )
    ).rows[0];
  }

  async customer(client: PoolClient, id: number) {
    return (
      await client.query<{ status: string }>(
        'SELECT status FROM customers WHERE customer_seq=$1 FOR SHARE',
        [id],
      )
    ).rows[0];
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

  async insert(client: PoolClient, draft: OrderDraft): Promise<CreatedOrderDto> {
    const id = (
      await client.query<{ id: number }>(
        `INSERT INTO orders(customer_seq,payment_method_type,pickup_requested_at,status)
       VALUES($1,$2,$3,'COLLECTING') RETURNING order_seq AS id`,
        [draft.customerSeq, draft.paymentMethodType, draft.pickupRequestedAt],
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

  async rememberCreation(
    client: PoolClient,
    adminId: number,
    key: string,
    hash: string,
    result: CreatedOrderDto,
  ) {
    await client.query(
      `INSERT INTO api_idempotency.order_creations(admin_user_seq,idempotency_key,request_hash,order_seq,response_version)
       VALUES($1,$2::uuid,$3,$4,$5)`,
      [adminId, key, hash, result.orderSeq, result.version],
    );
  }
}
