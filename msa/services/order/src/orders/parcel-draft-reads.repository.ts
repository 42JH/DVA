import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DraftReadCall, DraftCallReferences } from '@dva/events/parcel-drafts.cjs';
import { readPage } from '../common/pagination-query';
import { searchOrderSequence } from '../common/search-order-sequence';
import { ParcelDraftQueryDto } from './dto/parcel-draft.dto';
import type { ParcelDraftRow } from './parcel-drafts.types';
import { availableDraftIds, availableDraftSql } from './parcel-draft-reads';
type ReadCalls = (input: {
  callIds: number[];
  customerIds: number[];
  phones: string[];
}) => Promise<DraftCallReferences>;
export const columns = `draft_seq AS "draftSeq",reserved_order_seq AS "reservedOrderSeq",call_session_seq AS "callSessionSeq",customer_seq AS "customerSeq",caller_phone_number AS "callerPhoneNumber",
 created_by_admin_user_seq AS "createdByAdminUserSeq",client_parcel_id AS "clientParcelId",
 parcel_data AS parcel,status,version,source_draft_seq AS "sourceDraftSeq",order_seq AS "orderSeq",order_parcel_seq AS "orderParcelSeq",
 legacy_order_seq AS "legacyOrderSeq",legacy_order_parcel_seq AS "legacyOrderParcelSeq",
 created_at AS "createdAt",updated_at AS "updatedAt",retention_started_at AS "retentionStartedAt"`;

@Injectable()
export class ParcelDraftReadsRepository {
  private matching(
    query: ParcelDraftQueryDto,
    customerId: number | null,
    endedCallId: number | null,
    call: DraftReadCall | null,
    organizationCustomers: number[] | null,
  ) {
    const phoneQuery =
      query.q && /^[0-9+() -]+$/.test(query.q) ? query.q.replace(/[^0-9]/g, '') : null;
    return {
      where: `($7::int IS NOT NULL OR $1::int IS NULL OR d.customer_seq=$1)
       AND ($7::int IS NULL OR (d.customer_seq IS NOT NULL AND d.customer_seq=$1) OR
        (d.customer_seq IS NULL AND (d.call_session_seq=$7 OR (d.status='INCOMPLETE' AND d.caller_phone_number=$8))))
       AND ($2::text='ALL' OR d.status=$2)
       AND ($3::int IS NULL OR d.call_session_seq=$3) AND ($4::int IS NULL OR d.call_session_seq=$4)
       AND ($6::int IS NULL OR d.legacy_order_seq=$6) AND ($5::text IS NULL OR d.reserved_order_seq=$13::int OR strpos(lower(normalize(concat_ws(' ',
        d.parcel_data->'origin'->>'name',d.parcel_data->'origin'->>'phoneNumber',d.parcel_data->'origin'->>'roadAddress',d.parcel_data->'origin'->>'jibunAddress',
        d.parcel_data->'destination'->>'name',d.parcel_data->'destination'->>'phoneNumber',d.parcel_data->'destination'->>'roadAddress',d.parcel_data->'destination'->>'jibunAddress',
        d.parcel_data->'origin'->>'detailAddress',d.parcel_data->'destination'->>'detailAddress'),NFC)),lower(normalize($5,NFC)))>0
        OR ($12::text IS NOT NULL AND (strpos(d.parcel_data->'origin'->>'phoneNumber',$12)>0 OR strpos(d.parcel_data->'destination'->>'phoneNumber',$12)>0)))
       AND ($9::timestamptz IS NULL OR d.created_at>=$9) AND ($10::timestamptz IS NULL OR d.created_at<$10)
       AND ($11::int[] IS NULL OR d.customer_seq=ANY($11))`,
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
        organizationCustomers,
        phoneQuery || null,
        call === null ? searchOrderSequence(query.q) : null,
      ],
    };
  }

  async draft(client: PoolClient, id: number, readCalls: ReadCalls, update = false) {
    const ids = await availableDraftIds(client, 'd.draft_seq=$1', [id], readCalls);
    const row = (
      await client.query<ParcelDraftRow>(
        `SELECT ${columns} FROM order_parcel_drafts d WHERE d.draft_seq=$1 AND ${availableDraftSql(2)}` +
          (update ? ' FOR UPDATE OF d' : ''),
        [id, ids],
      )
    ).rows[0];
    if (update && row) {
      const current = await availableDraftIds(client, 'd.draft_seq=$1', [id], readCalls, true);
      if (
        !(
          await client.query(
            `SELECT 1 FROM order_parcel_drafts d WHERE d.draft_seq=$1 AND ${availableDraftSql(2, true)}`,
            [id, current],
          )
        ).rowCount
      )
        return undefined;
    }
    return row;
  }
  async list(
    client: PoolClient,
    query: ParcelDraftQueryDto,
    customerId: number | null,
    endedCallId: number | null,
    call: DraftReadCall | null,
    organizationCustomers: number[] | null,
    readCalls: ReadCalls,
  ) {
    const filter = this.matching(query, customerId, endedCallId, call, organizationCustomers);
    const ids = await availableDraftIds(client, filter.where, filter.values, readCalls);
    return readPage<ParcelDraftRow>(
      client,
      `SELECT ${columns} FROM order_parcel_drafts d WHERE(${filter.where}) AND ${availableDraftSql(filter.values.length + 1)}`,
      [...filter.values, ids],
      query,
      '"createdAt" DESC,"draftSeq" DESC',
    );
  }
}
