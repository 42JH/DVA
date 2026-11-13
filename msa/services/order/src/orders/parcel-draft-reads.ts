import type { PoolClient } from 'pg';
import type { DraftCallReferences } from '@dva/events/parcel-drafts.cjs';
import { searchOrderSequence } from '../common/search-order-sequence';
import type { AdminOrderListQueryDto } from './dto/admin-order-list.dto';
type ReadCalls = (input: {
  callIds: number[];
  customerIds: number[];
  phones: string[];
}) => Promise<DraftCallReferences>;
export const transientDraft =
  "(d.status='INCOMPLETE' OR(d.source_draft_seq IS NOT NULL AND d.status IN('READY','EDITING')))";
export const availableDraftSql = (
  parameter: number,
  live = false,
) => `d.deleted_at IS NULL AND d.retention_started_at>${live ? 'clock_timestamp()' : 'transaction_timestamp()'}-interval '5 years'
 AND(NOT${transientDraft} OR(d.retention_started_at>${live ? 'clock_timestamp()' : 'transaction_timestamp()'}-interval '24 hours' AND d.draft_seq=ANY($${parameter}::int[])))`;

export async function incompleteDraftIds(
  client: PoolClient,
  query: AdminOrderListQueryDto,
  organizationCustomers: number[] | null,
  readCalls: ReadCalls,
): Promise<number[]> {
  const phoneQuery =
    query.q && /^[0-9+() -]+$/.test(query.q) ? query.q.replace(/[^0-9]/g, '') : null;
  return availableDraftIds(
    client,
    `d.status='INCOMPLETE'
   AND($1::text IS NULL OR d.reserved_order_seq=$6::int OR strpos(lower(normalize(concat_ws(' ',
    d.parcel_data->'origin'->>'name',d.parcel_data->'origin'->>'phoneNumber',d.parcel_data->'origin'->>'roadAddress',d.parcel_data->'origin'->>'jibunAddress',
    d.parcel_data->'destination'->>'name',d.parcel_data->'destination'->>'phoneNumber',d.parcel_data->'destination'->>'roadAddress',d.parcel_data->'destination'->>'jibunAddress',
    d.parcel_data->'origin'->>'detailAddress',d.parcel_data->'destination'->>'detailAddress'),NFC)),lower(normalize($1,NFC)))>0
    OR($2::text IS NOT NULL AND(strpos(d.parcel_data->'origin'->>'phoneNumber',$2)>0 OR strpos(d.parcel_data->'destination'->>'phoneNumber',$2)>0)))
   AND($3::timestamptz IS NULL OR d.created_at>=$3) AND($4::timestamptz IS NULL OR d.created_at<$4)
   AND($5::int[] IS NULL OR d.customer_seq=ANY($5))`,
    [
      query.q?.trim() || null,
      phoneQuery || null,
      query.from ?? null,
      query.to ?? null,
      organizationCustomers,
      searchOrderSequence(query.q),
    ],
    readCalls,
  );
}

// Both public draft reads and the admin screen use the same superseded-call predicate.
export async function availableDraftIds(
  client: PoolClient,
  where: string,
  values: unknown[],
  readCalls: ReadCalls,
  live = false,
): Promise<number[]> {
  const clock = live ? 'clock_timestamp()' : 'transaction_timestamp()';
  const ids: number[] = [];
  let cursor = 0;
  for (;;) {
    const { rows } = await client.query<{
      draft_seq: number;
      customer_seq: number | null;
      caller_phone_number: string | null;
      call_session_seq: number | null;
    }>(
      `SELECT d.draft_seq,d.customer_seq,d.caller_phone_number,COALESCE(d.call_session_seq,source.call_session_seq) AS call_session_seq
       FROM order_parcel_drafts d LEFT JOIN order_parcel_drafts source ON source.draft_seq=d.source_draft_seq
       WHERE d.draft_seq>$${values.length + 1} AND d.deleted_at IS NULL AND ${transientDraft}
        AND d.retention_started_at>${clock}-interval '5 years' AND d.retention_started_at>${clock}-interval '24 hours'
        AND(${where}) ORDER BY d.draft_seq LIMIT 250`,
      [...values, cursor],
    );
    if (!rows.length) return ids;
    const refs = await readCalls({
      callIds: rows.flatMap((row) => (row.call_session_seq === null ? [] : [row.call_session_seq])),
      customerIds: rows.flatMap((row) => (row.customer_seq === null ? [] : [row.customer_seq])),
      phones: rows.flatMap((row) =>
        row.customer_seq !== null || row.caller_phone_number === null
          ? []
          : [row.caller_phone_number],
      ),
    });
    const available = await client.query<{ draft_seq: number }>(
      `WITH origins AS(SELECT * FROM jsonb_to_recordset($2::jsonb) AS c(call_session_seq int,started_at timestamptz)),
       latest AS(SELECT call_session_seq,customer_seq,NULL::text AS caller_phone_number,started_at FROM jsonb_to_recordset($3::jsonb) AS c(call_session_seq int,customer_seq int,started_at timestamptz)
         UNION ALL SELECT call_session_seq,NULL::int,caller_phone_number,started_at FROM jsonb_to_recordset($4::jsonb) AS c(call_session_seq int,caller_phone_number text,started_at timestamptz))
       SELECT d.draft_seq FROM order_parcel_drafts d WHERE d.draft_seq=ANY($1::int[]) AND NOT EXISTS(
         SELECT 1 FROM latest newer LEFT JOIN order_parcel_drafts source ON source.draft_seq=d.source_draft_seq
         LEFT JOIN origins origin ON origin.call_session_seq=COALESCE(d.call_session_seq,source.call_session_seq)
         WHERE((d.customer_seq IS NOT NULL AND newer.customer_seq=d.customer_seq)OR(d.customer_seq IS NULL AND newer.caller_phone_number=d.caller_phone_number))
          AND(newer.started_at,newer.call_session_seq)>(COALESCE(origin.started_at,d.retention_started_at),COALESCE(origin.call_session_seq,0))) ORDER BY d.draft_seq`,
      [
        rows.map((row) => row.draft_seq),
        JSON.stringify(refs.calls),
        JSON.stringify(refs.customers),
        JSON.stringify(refs.phones),
      ],
    );
    ids.push(...available.rows.map((row) => row.draft_seq));
    cursor = rows[rows.length - 1].draft_seq;
  }
}
