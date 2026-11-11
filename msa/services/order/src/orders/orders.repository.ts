import type { UpdateOrderDto, UpdatedOrderDto, ParcelChangeDto } from './dto/update-order.dto';
import { ORDER_ADDRESS_FIELDS, type OrderDraft } from './order-draft';
import type { OrderAddressPatchDto } from './dto/create-order.dto';
import type { OriginPinDto } from './dto/origin-pin.dto';
import type { OrderCreationSource } from './orders.types';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { IntakeOrderResult } from '@dva/events/order-read.cjs';
import { readPage } from '../common/pagination-query';
import {
  AdminOrderListItemDto,
  AdminOrderListQueryDto,
  AdminOrderStatusCountsDto,
} from './dto/admin-order-list.dto';
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
  async result(client: Pool | PoolClient, id: number, callId: number) {
    return (
      await client.query<IntakeOrderResult>(
        `SELECT order_seq AS "orderSeq",version,status,total_amount AS "totalAmount",parcel_no AS "parcelNo",$2::int AS "callSessionSeq",
         payment_due_at AS "paymentDueAt",${paymentRequestJson} AS "paymentRequest"
         FROM orders o WHERE order_seq=$1 AND o.deleted_at IS NULL
          AND COALESCE(o.closed_at,o.created_at)>statement_timestamp()-interval '5 years'`,
        [id, callId],
      )
    ).rows[0];
  }

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

  async hasMigratedDrafts(client: PoolClient, id: number): Promise<boolean> {
    return !!(
      await client.query('SELECT 1 FROM order_parcel_drafts WHERE legacy_order_seq=$1 LIMIT 1', [
        id,
      ])
    ).rowCount;
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

  async cancel(client: PoolClient, id: number) {
    await client.query(
      "UPDATE orders SET status='CANCELLED',version=version+1 WHERE order_seq=$1",
      [id],
    );
  }

  async lockParcels(client: PoolClient, id: number) {
    return (
      await client.query<{
        orderParcelSeq: number;
        status: 'ACTIVE' | 'CANCELLED';
        notifiedPrice: number | null;
      }>(
        `SELECT order_parcel_seq AS "orderParcelSeq",status,notified_price AS "notifiedPrice" FROM order_parcels
         WHERE order_seq=$1 ORDER BY order_parcel_seq FOR UPDATE`,
        [id],
      )
    ).rows;
  }

  async cancelParcel(client: PoolClient, id: number) {
    await client.query("UPDATE order_parcels SET status='CANCELLED' WHERE order_parcel_seq=$1", [
      id,
    ]);
  }

  async recalculateAmount(client: PoolClient, id: number): Promise<number | null> {
    return (
      await client.query<{ amount: number | null }>(
        `UPDATE orders SET total_amount=(SELECT CASE WHEN count(*)=0 THEN 0
         WHEN count(notified_price)=count(*) THEN sum(notified_price)::int END
         FROM order_parcels WHERE order_seq=$1 AND status='ACTIVE')
       WHERE order_seq=$1 RETURNING total_amount AS amount`,
        [id],
      )
    ).rows[0].amount;
  }

  async replaceRequest(client: PoolClient, id: number) {
    await client.query(
      'UPDATE order_payment_requests SET invalidated_at=clock_timestamp() WHERE order_seq=$1 AND invalidated_at IS NULL AND completed_at IS NULL',
      [id],
    );
    await client.query(
      `INSERT INTO order_payment_requests(order_seq,amount,expires_at)
      SELECT order_seq,total_amount,payment_due_at FROM orders WHERE order_seq=$1 AND status='notPaid' AND total_amount>0`,
      [id],
    );
  }
  async isApproving(client: PoolClient, id: number) {
    return (
      (
        await client.query(
          `SELECT 1 FROM order_payment_requests WHERE order_seq=$1 AND invalidated_at IS NULL AND completed_at IS NULL AND approval_started_at IS NOT NULL`,
          [id],
        )
      ).rowCount !== 0
    );
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

  private adminFilter(query: AdminOrderListQueryDto, organizationCustomers: number[] | null) {
    const phoneQuery =
      query.q && /^[0-9+() -]+$/.test(query.q) ? query.q.replace(/[^0-9]/g, '') : null;
    return {
      sql: `FROM orders o
       WHERE o.deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM order_parcel_drafts d WHERE d.legacy_order_seq=o.order_seq) AND COALESCE(o.closed_at,o.created_at)>transaction_timestamp()-interval '5 years'
        AND ($1::text IS NULL OR EXISTS(SELECT 1 FROM order_parcels p WHERE p.order_seq=o.order_seq AND (
         EXISTS(SELECT 1 FROM unnest(ARRAY[p.origin_name,p.origin_phone_number,p.origin_road_address,p.origin_jibun_address,p.origin_detail_address,
           p.destination_name,p.destination_phone_number,p.destination_road_address,p.destination_jibun_address,p.destination_detail_address]) AS v(value)
           WHERE strpos(lower(normalize(v.value,NFC)),lower($1))>0)
         OR ($5::text IS NOT NULL AND (strpos(p.origin_phone_number,$5)>0 OR strpos(p.destination_phone_number,$5)>0)))))
        AND ($2::timestamptz IS NULL OR o.created_at >= $2)
        AND ($3::timestamptz IS NULL OR o.created_at < $3)
        AND ($4::text IS NULL OR o.status=$4 OR ($4='PAID' AND o.status IN ('SUBMITTING','SUBMITTING_FAILED')))
         AND ($6::int[] IS NULL OR o.customer_seq=ANY($6))`,
      values: [
        query.q || null,
        query.from ?? null,
        query.to ?? null,
        query.statusGroup ?? null,
        phoneQuery || null,
        organizationCustomers,
      ],
    };
  }

  async adminStatusCounts(
    client: PoolClient,
    query: AdminOrderListQueryDto,
    organizationCustomers: number[] | null,
  ) {
    const filter = this.adminFilter({ ...query, statusGroup: undefined }, organizationCustomers);
    return (
      await client.query<{ data: Omit<AdminOrderStatusCountsDto, 'incomplete'> }>(
        `SELECT jsonb_build_object('all',count(*),'notPaid',count(*) FILTER(WHERE o.status='notPaid'),
       'paid',count(*) FILTER(WHERE o.status IN ('PAID','SUBMITTING','SUBMITTING_FAILED')),
       'accepted',count(*) FILTER(WHERE o.status='ACCEPTED'),
       'submissionFailed',count(*) FILTER(WHERE o.status='SUBMISSION_FAILED'),
       'cancelled',count(*) FILTER(WHERE o.status='CANCELLED')) AS data ${filter.sql}`,
        filter.values,
      )
    ).rows[0].data;
  }

  async adminList(
    client: Pool | PoolClient,
    query: AdminOrderListQueryDto,
    organizationCustomers: number[] | null,
    draftIds: number[],
  ) {
    const filter = this.adminFilter(query, organizationCustomers);
    const orders = `SELECT o.order_seq AS "orderSeq",o.status,o.created_at AS "createdAt",o.pickup_requested_at AS "pickupRequestedAt",
       o.customer_seq AS "customerSeq",NULL::text AS "organizationName",NULL::int AS "draftSeq",NULL::jsonb AS "_draftParcel" ${filter.sql}`;
    const drafts = {
      sql: `SELECT d.reserved_order_seq AS "orderSeq",'COLLECTING'::text AS status,d.created_at AS "createdAt",NULL::timestamptz AS "pickupRequestedAt",
      d.customer_seq AS "customerSeq",NULL::text AS "organizationName",d.draft_seq AS "draftSeq",d.parcel_data AS "_draftParcel"
      FROM order_parcel_drafts d WHERE d.draft_seq=ANY($1::int[])`,
      values: [draftIds],
    };
    const onlyDrafts = query.statusGroup === 'COLLECTING';
    const combined = query.statusGroup === undefined;
    const sql = onlyDrafts
      ? drafts.sql
      : combined
        ? `${orders} UNION ALL ${drafts.sql.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + filter.values.length}`)}`
        : orders;
    const values = onlyDrafts
      ? drafts.values
      : combined
        ? [...filter.values, ...drafts.values]
        : filter.values;
    return readPage<AdminOrderListItemDto>(
      client,
      sql,
      values,
      query,
      '"createdAt" DESC,"orderSeq" DESC',
      `page."orderSeq",page.status,page."createdAt",page."pickupRequestedAt",page."customerSeq",page."organizationName",page."draftSeq",page.__page_ordinal,
       CASE WHEN page."draftSeq" IS NOT NULL THEN jsonb_build_array(jsonb_build_object(
         'orderParcelSeq',NULL,'status','ACTIVE',
         'origin',jsonb_build_object('name',page."_draftParcel"->'origin'->'name','phoneNumber',page."_draftParcel"->'origin'->'phoneNumber',
           'roadAddress',page."_draftParcel"->'origin'->'roadAddress','jibunAddress',page."_draftParcel"->'origin'->'jibunAddress','detailAddress',page."_draftParcel"->'origin'->'detailAddress'),
         'destination',jsonb_build_object('name',page."_draftParcel"->'destination'->'name','phoneNumber',page."_draftParcel"->'destination'->'phoneNumber',
           'roadAddress',page."_draftParcel"->'destination'->'roadAddress','jibunAddress',page."_draftParcel"->'destination'->'jibunAddress','detailAddress',page."_draftParcel"->'destination'->'detailAddress'),
         'documentCount',COALESCE((page."_draftParcel"->>'documentCount')::int,0),'smallBoxCount',COALESCE((page."_draftParcel"->>'smallBoxCount')::int,0),
         'mediumBoxCount',COALESCE((page."_draftParcel"->>'mediumBoxCount')::int,0),'bigBoxCount',COALESCE((page."_draftParcel"->>'bigBoxCount')::int,0),
         'otherItemDescription',COALESCE(page."_draftParcel"->>'otherItemDescription','')))
       ELSE COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'orderParcelSeq',p.order_parcel_seq,'status',p.status,
         'origin',jsonb_build_object('name',p.origin_name,'phoneNumber',p.origin_phone_number,'roadAddress',p.origin_road_address,'jibunAddress',p.origin_jibun_address,'detailAddress',p.origin_detail_address),
         'destination',jsonb_build_object('name',p.destination_name,'phoneNumber',p.destination_phone_number,'roadAddress',p.destination_road_address,'jibunAddress',p.destination_jibun_address,'detailAddress',p.destination_detail_address),
         'documentCount',p.document_count,'smallBoxCount',p.small_box_count,'mediumBoxCount',p.medium_box_count,'bigBoxCount',p.big_box_count,'otherItemDescription',p.other_item_description)
         ORDER BY p.parcel_position,p.order_parcel_seq) FROM order_parcels p WHERE p.order_seq=page."orderSeq"),'[]'::jsonb) END AS parcels`,
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
         WHERE o.deleted_at IS NULL
       AND NOT EXISTS(SELECT 1 FROM order_parcel_drafts d WHERE d.legacy_order_seq=o.order_seq)
       AND COALESCE(o.closed_at,o.created_at)>clock_timestamp()-interval '5 years'
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
  async lockCreation(client: PoolClient, key: string): Promise<boolean> {
    const hash = createHash('sha256').update(`orders.create:${key}`).digest();
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1::int, $2::int) AS acquired',
      [hash.readInt32BE(0), hash.readInt32BE(4)],
    );
    return result.rows[0].acquired;
  }
  async parcelReferences(client: PoolClient, id: number) {
    return (
      await client.query<{
        orderParcelSeq: number;
        parcelPosition: number;
        status: 'ACTIVE' | 'CANCELLED';
        originPin: OriginPinDto | null;
        origin: Required<OrderAddressPatchDto>;
      }>(
        `SELECT order_parcel_seq AS "orderParcelSeq",parcel_position AS "parcelPosition",status,
          CASE WHEN origin_pin_seq IS NULL THEN NULL
            ELSE jsonb_build_object('scope',origin_pin_scope,'pinSeq',origin_pin_seq) END AS "originPin",
          jsonb_build_object('name',origin_name,'phoneNumber',origin_phone_number,
            'roadAddress',origin_road_address,'jibunAddress',origin_jibun_address,
            'detailAddress',origin_detail_address,'dongName',origin_dong_name,'postalCode',origin_postal_code) AS origin
         FROM order_parcels WHERE order_seq=$1 ORDER BY parcel_position`,
        [id],
      )
    ).rows;
  }

  async insert(
    client: PoolClient,
    draft: OrderDraft,
    customerId: number | null,
    key: string,
    creationSource: OrderCreationSource,
    adminId: number | null = null,
    reservedOrderSeq: number | null = null,
  ) {
    const id = (
      await client.query<{ id: number }>(
        `INSERT INTO orders(customer_seq,payment_method_type,pickup_requested_at,status,creation_request_id,creation_source,total_amount,created_by_admin_user_seq,order_seq)
         OVERRIDING SYSTEM VALUE
         VALUES($1,$2,$3,'COLLECTING',$4::uuid,$5,$6,$7,COALESCE($8::int,nextval('orders_order_seq_seq'::regclass))) RETURNING order_seq AS id`,
        [
          customerId,
          draft.paymentMethodType,
          draft.pickupRequestedAt,
          key,
          creationSource,
          draft.totalAmount,
          adminId,
          reservedOrderSeq,
        ],
      )
    ).rows[0].id;
    await this.insertParcels(client, id, 1, draft.parcels);
    // 상세 추가 트리거가 버전을 올리므로 초기값이나 상세 수로 추정하지 않는다.
    return {
      orderSeq: id,
      ...(
        await client.query<{ version: number }>('SELECT version FROM orders WHERE order_seq=$1', [
          id,
        ])
      ).rows[0],
    };
  }

  async insertParcels(
    client: PoolClient,
    id: number,
    position: number,
    parcels: OrderDraft['parcels'],
  ) {
    const columns = `order_seq,parcel_position,
          origin_name,origin_phone_number,origin_road_address,origin_jibun_address,origin_detail_address,
          origin_dong_name,origin_postal_code,
          destination_name,destination_phone_number,destination_road_address,destination_jibun_address,destination_detail_address,
          destination_dong_name,destination_postal_code,
          origin_pin_scope,origin_pin_seq,document_count,small_box_count,medium_box_count,big_box_count,
          other_item_description,client_comment,item_price,notified_price`;
    // 행 트리거 비용을 문장별 timeout 안에 나누되 요청 전체는 같은 트랜잭션에 둔다.
    for (let offset = 0; offset < parcels.length; offset += 200) {
      const rows = parcels.slice(offset, offset + 200).map((parcel, index) => ({
        order_seq: id,
        parcel_position: position + offset + index,
        ...Object.fromEntries(
          (['origin', 'destination'] as const).flatMap((side) =>
            ORDER_ADDRESS_FIELDS.map((field) => [
              `${side}_${field.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())}`,
              parcel[side][field],
            ]),
          ),
        ),
        origin_pin_scope: parcel.originPin?.scope ?? null,
        origin_pin_seq: parcel.originPin?.pinSeq ?? null,
        document_count: parcel.documentCount,
        small_box_count: parcel.smallBoxCount,
        medium_box_count: parcel.mediumBoxCount,
        big_box_count: parcel.bigBoxCount,
        other_item_description: parcel.otherItemDescription,
        client_comment: parcel.clientComment,
        item_price: parcel.itemPrice,
        notified_price: parcel.notifiedPrice,
      }));
      await client.query(
        `INSERT INTO order_parcels (${columns}) SELECT ${columns}
         FROM jsonb_populate_recordset(NULL::order_parcels,$1::jsonb) ORDER BY parcel_position`,
        [JSON.stringify(rows)],
      );
    }
  }
  async updateHeader(client: PoolClient, id: number, input: UpdateOrderDto) {
    // 같은 값을 저장해도 버전을 소비해 이전 expectedVersion의 재전송을 막는다.
    await client.query(
      `UPDATE orders SET version=version+1,
         payment_method_type=COALESCE($2,payment_method_type),
         pickup_requested_at=CASE WHEN $3 THEN $4::timestamptz ELSE pickup_requested_at END,
         total_amount=CASE WHEN $5 THEN $6::int ELSE total_amount END
       WHERE order_seq=$1`,
      [
        id,
        input.paymentMethodType ?? null,
        input.pickupRequestedAt !== undefined,
        input.pickupRequestedAt ?? null,
        input.totalAmount !== undefined,
        input.totalAmount ?? null,
      ],
    );
  }

  async updateParcel(client: PoolClient, orderId: number, parcel: ParcelChangeDto) {
    const values: unknown[] = [orderId, parcel.orderParcelSeq];
    const changes: string[] = [];
    const set = (column: string, value: unknown) => {
      if (value !== undefined) {
        values.push(value);
        changes.push(`${column}=$${values.length}`);
      }
    };
    for (const side of ['origin', 'destination'] as const)
      for (const field of ORDER_ADDRESS_FIELDS)
        set(
          `${side}_${field.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase())}`,
          parcel[side]?.[field],
        );
    for (const field of [
      'documentCount',
      'smallBoxCount',
      'mediumBoxCount',
      'bigBoxCount',
      'otherItemDescription',
      'clientComment',
      'itemPrice',
      'notifiedPrice',
    ] as const)
      set(
        field.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()),
        parcel[field],
      );
    if (parcel.originPin !== undefined) {
      set('origin_pin_scope', parcel.originPin?.scope ?? null);
      set('origin_pin_seq', parcel.originPin?.pinSeq ?? null);
    }
    await client.query(
      `UPDATE order_parcels SET ${changes.join(',')} WHERE order_seq=$1 AND order_parcel_seq=$2`,
      values,
    );
  }

  async currentVersion(client: PoolClient, id: number): Promise<UpdatedOrderDto> {
    return (
      await client.query<UpdatedOrderDto>('SELECT version FROM orders WHERE order_seq=$1', [id])
    ).rows[0];
  }
}
