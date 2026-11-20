import { preparedQuery } from '../database/prepared-query';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { readPage } from '../common/pagination-query';
import { searchSequence } from '../common/search-sequence';
import { ParcelDraftQueryDto } from './dto/parcel-draft.dto';
import { AdminOrderListQueryDto } from './dto/admin-order-list.dto';
import { OrderIntakeCall, ParcelDraftRow } from './parcel-drafts.types';

const columns = `draft_seq AS "draftSeq",reserved_order_seq AS "reservedOrderSeq",call_session_seq AS "callSessionSeq",customer_seq AS "customerSeq",caller_phone_number AS "callerPhoneNumber",
 created_by_admin_user_seq AS "createdByAdminUserSeq",client_parcel_id AS "clientParcelId",creation_payload AS "creationPayload",
 parcel_data AS parcel,status,version,source_draft_seq AS "sourceDraftSeq",order_seq AS "orderSeq",order_parcel_seq AS "orderParcelSeq",
 legacy_order_seq AS "legacyOrderSeq",legacy_order_parcel_seq AS "legacyOrderParcelSeq",
 created_at AS "createdAt",updated_at AS "updatedAt",retention_started_at AS "retentionStartedAt"`;
// A deleted newer call must not revive the older incomplete parcels it superseded.
const available = `d.deleted_at IS NULL
 AND (NOT(d.status='INCOMPLETE' OR (d.source_draft_seq IS NOT NULL AND d.status IN('READY','EDITING')))
 OR (d.retention_started_at>transaction_timestamp()-interval '24 hours' AND NOT EXISTS(
   SELECT 1 FROM call_sessions newer
   LEFT JOIN order_parcel_drafts source ON source.draft_seq=d.source_draft_seq
   LEFT JOIN call_sessions origin ON origin.call_session_seq=COALESCE(d.call_session_seq,source.call_session_seq)
   WHERE newer.ended_at IS NOT NULL AND newer.order_finalized_at IS NOT NULL
    AND ((d.customer_seq IS NOT NULL AND newer.customer_seq=d.customer_seq)
      OR (d.customer_seq IS NULL AND newer.caller_phone_number=d.caller_phone_number))
    AND (COALESCE(newer.incoming_at,newer.started_at,newer.registered_at),newer.call_session_seq)>
      (COALESCE(origin.incoming_at,origin.started_at,origin.registered_at,d.retention_started_at),COALESCE(origin.call_session_seq,0))
 )))`;

@Injectable()
export class ParcelDraftsRepository {
  async lockScope(
    client: PoolClient,
    customerId: number | null,
    callerPhone: string | null = null,
  ) {
    if (customerId !== null)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('parcel-drafts.customer:'||$1::text,0))",
        [customerId],
      );
    const phone =
      callerPhone ??
      (customerId === null
        ? null
        : (
            await client.query<{ phone: string }>(
              'SELECT phone_number AS phone FROM customers WHERE customer_seq=$1',
              [customerId],
            )
          ).rows[0]?.phone);
    if (phone)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('parcel-drafts.phone:'||$1::text,0))",
        [phone],
      );
  }

  async call(client: PoolClient, id: number, update = true) {
    return (
      await client.query<OrderIntakeCall>(
        `SELECT call_session_seq AS "callSessionSeq",caller_phone_number AS "callerPhoneNumber",customer_seq AS "customerSeq",
      ended_at AS "endedAt",order_seq AS "orderSeq",order_intake_enabled AS enabled,order_intake_version AS "intakeVersion",
      order_completion_received_at AS "completionReceivedAt",order_completion_payload AS "completionPayload",
      order_finalized_at AS "finalizedAt",order_finalization_result AS "finalizationResult",order_finalization_error_code AS "errorCode"
      FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
       AND incoming_at>statement_timestamp()-interval '5 years' FOR ${update ? 'UPDATE' : 'SHARE'}`,
        [id],
      )
    ).rows[0];
  }

  async customer(client: PoolClient, id: number): Promise<boolean> {
    return !!(
      await client.query(
        "SELECT 1 FROM customers WHERE customer_seq=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR SHARE",
        [id],
      )
    ).rowCount;
  }

  async draft(client: PoolClient, id: number, update = false) {
    const row = (
      await client.query<ParcelDraftRow>(
        preparedQuery(
          `SELECT ${columns} FROM order_parcel_drafts d WHERE draft_seq=$1 AND ${available}${update ? ' FOR UPDATE OF d' : ''}`,
          [id],
        ),
      )
    ).rows[0];
    if (
      update &&
      row &&
      !(
        await client.query(
          preparedQuery(
            `SELECT 1 FROM order_parcel_drafts d WHERE draft_seq=$1 AND ${available.replaceAll('transaction_timestamp()', 'clock_timestamp()')}`,
            [id],
          ),
        )
      ).rowCount
    )
      return undefined;
    return row;
  }

  async byClientId(client: PoolClient, callId: number | null, key: string) {
    return (
      await client.query<ParcelDraftRow & { unavailable: boolean }>(
        `SELECT ${columns},NOT(${available.replaceAll('transaction_timestamp()', 'clock_timestamp()')}) AS unavailable
      FROM order_parcel_drafts d WHERE call_session_seq IS NOT DISTINCT FROM $1::int AND client_parcel_id=$2::uuid FOR UPDATE OF d`,
        [callId, key],
      )
    ).rows[0];
  }

  private matching(
    query: ParcelDraftQueryDto,
    customerId: number | null,
    endedCallId: number | null,
    call: OrderIntakeCall | null,
  ) {
    const phoneQuery =
      query.q && /^[0-9+() -]+$/.test(query.q) ? query.q.replace(/[^0-9]/g, '') : null;
    return {
      sql: `FROM order_parcel_drafts d WHERE ${available}
       AND ($7::int IS NOT NULL OR $1::int IS NULL OR customer_seq=$1)
       AND ($7::int IS NULL OR (customer_seq IS NOT NULL AND customer_seq=$1) OR
        (customer_seq IS NULL AND (call_session_seq=$7 OR (status='INCOMPLETE' AND caller_phone_number=$8))))
       AND ($2::text='ALL' OR status=$2)
       AND ($3::int IS NULL OR call_session_seq=$3) AND ($4::int IS NULL OR call_session_seq=$4)
       AND ($6::int IS NULL OR legacy_order_seq=$6) AND ($5::text IS NULL OR d.reserved_order_seq=$13::int OR strpos(lower(normalize(concat_ws(' ',
        parcel_data->'origin'->>'name',parcel_data->'origin'->>'phoneNumber',parcel_data->'origin'->>'roadAddress',parcel_data->'origin'->>'jibunAddress',
        parcel_data->'destination'->>'name',parcel_data->'destination'->>'phoneNumber',parcel_data->'destination'->>'roadAddress',parcel_data->'destination'->>'jibunAddress',
        parcel_data->'origin'->>'detailAddress',parcel_data->'destination'->>'detailAddress'),NFC)),lower(normalize($5,NFC)))>0
        OR ($12::text IS NOT NULL AND (strpos(parcel_data->'origin'->>'phoneNumber',$12)>0 OR strpos(parcel_data->'destination'->>'phoneNumber',$12)>0)))
       AND ($9::timestamptz IS NULL OR created_at>=$9) AND ($10::timestamptz IS NULL OR created_at<$10)
       AND ($11::int IS NULL OR EXISTS(SELECT 1 FROM customers c JOIN memberships m USING(customer_seq)
        JOIN organizations o ON o.organization_seq=m.organization_seq WHERE c.customer_seq=d.customer_seq
         AND c.deleted_at IS NULL AND m.deleted_at IS NULL AND o.deleted_at IS NULL AND o.organization_seq=$11))`,
      values: [
        customerId,
        query.status,
        query.callSessionSeq ?? null,
        endedCallId,
        query.q?.trim() || null,
        query.legacyOrderSeq ?? null,
        call?.callSessionSeq ?? null,
        call?.callerPhoneNumber ?? null,
        query.from ?? null,
        query.to ?? null,
        query.organizationSeq ?? null,
        phoneQuery || null,
        call === null ? searchSequence(query.q, 'DV-') : null,
      ],
    };
  }

  adminIncompleteRows(query: AdminOrderListQueryDto) {
    const filter = this.matching(
      Object.assign(new ParcelDraftQueryDto(), {
        status: 'INCOMPLETE',
        q: query.q,
        from: query.from,
        to: query.to,
        organizationSeq: query.organizationSeq,
      }),
      null,
      null,
      null,
    );
    return {
      sql: `SELECT d.reserved_order_seq AS "orderSeq",'COLLECTING'::text AS status,d.created_at AS "createdAt",
        NULL::timestamptz AS "pickupRequestedAt",customer.customer_seq AS "customerSeq",company.name AS "organizationName",
        d.draft_seq AS "draftSeq",d.parcel_data AS "_draftParcel"
        FROM (SELECT draft_seq,reserved_order_seq,created_at,customer_seq,parcel_data ${filter.sql}) d
        LEFT JOIN customers customer ON customer.customer_seq=d.customer_seq AND customer.deleted_at IS NULL
        LEFT JOIN memberships membership ON membership.customer_seq=customer.customer_seq AND membership.deleted_at IS NULL
        LEFT JOIN organizations company ON company.organization_seq=membership.organization_seq AND company.deleted_at IS NULL`,
      values: filter.values,
    };
  }

  async countIncomplete(client: PoolClient, query: ParcelDraftQueryDto): Promise<number> {
    const filter = this.matching({ ...query, status: 'INCOMPLETE' }, null, null, null);
    return (
      await client.query<{ count: number }>(
        `SELECT count(*)::integer AS count ${filter.sql}`,
        filter.values,
      )
    ).rows[0].count;
  }

  async list(
    client: PoolClient,
    query: ParcelDraftQueryDto,
    customerId: number | null,
    endedCallId: number | null,
    call: OrderIntakeCall | null,
  ) {
    const filter = this.matching(query, customerId, endedCallId, call);
    return readPage<Omit<ParcelDraftRow, 'creationPayload'>>(
      client,
      `SELECT ${columns.replace(',creation_payload AS "creationPayload"', '')} ${filter.sql}`,
      filter.values,
      query,
      '"createdAt" DESC,"draftSeq" DESC',
    );
  }

  async insert(
    client: PoolClient,
    input: {
      callId: number | null;
      customerId: number | null;
      callerPhoneNumber: string | null;
      adminId: number | null;
      key: string;
      payload: Record<string, unknown>;
      parcel: ParcelDraftRow['parcel'];
      status: 'READY' | 'EDITING';
      source?: ParcelDraftRow;
    },
  ) {
    const id = (
      await client.query<{ id: number }>(
        `INSERT INTO order_parcel_drafts(call_session_seq,customer_seq,caller_phone_number,created_by_admin_user_seq,client_parcel_id,creation_payload,parcel_data,status,source_draft_seq,retention_started_at,reserved_order_seq)
      VALUES($1,$2,$10,$3,$4::uuid,$5::jsonb,$6::jsonb,$7,$8,COALESCE($9::timestamptz,clock_timestamp()),COALESCE($11::int,nextval('orders_order_seq_seq'::regclass))) RETURNING draft_seq AS id`,
        [
          input.callId,
          input.customerId,
          input.adminId,
          input.key,
          JSON.stringify(input.payload),
          JSON.stringify(input.parcel),
          input.status,
          input.source?.draftSeq ?? null,
          input.source?.retentionStartedAt ?? null,
          input.callerPhoneNumber,
          input.source?.reservedOrderSeq ?? null,
        ],
      )
    ).rows[0].id;
    return this.draft(client, id, input.source !== undefined);
  }

  async update(
    client: PoolClient,
    id: number,
    parcel: ParcelDraftRow['parcel'],
    status: ParcelDraftRow['status'],
  ) {
    await client.query(
      `UPDATE order_parcel_drafts SET parcel_data=$2::jsonb,status=$3,version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1`,
      [id, JSON.stringify(parcel), status],
    );
  }

  async markConverted(
    client: PoolClient,
    draftSeq: number,
    orderSeq: number | null,
    orderParcelSeq: number,
  ): Promise<void> {
    await client.query(
      "UPDATE order_parcel_drafts SET status='CONVERTED',order_seq=$2,order_parcel_seq=$3,version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1",
      [draftSeq, orderSeq, orderParcelSeq],
    );
  }

  async softDelete(client: PoolClient, id: number): Promise<void> {
    await client.query(
      'UPDATE order_parcel_drafts SET deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1',
      [id],
    );
  }

  async bumpCall(client: PoolClient, id: number): Promise<number> {
    return (
      await client.query<{ version: number }>(
        'UPDATE call_sessions SET order_intake_version=order_intake_version+1 WHERE call_session_seq=$1 RETURNING order_intake_version AS version',
        [id],
      )
    ).rows[0].version;
  }
}
