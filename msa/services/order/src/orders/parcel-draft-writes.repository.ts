import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { availableDraftIds, availableDraftSql } from './parcel-draft-reads';
import { columns, ParcelDraftReadsRepository } from './parcel-draft-reads.repository';
import { ParcelDraftWriteScope } from './parcel-draft-write-scope.service';
import type { ParcelDraftRow } from './parcel-drafts.types';

@Injectable()
export class ParcelDraftWritesRepository {
  constructor(
    private readonly reads: ParcelDraftReadsRepository,
    private readonly scope: ParcelDraftWriteScope,
  ) {}

  call(_client: PoolClient, id: number) {
    return this.scope.call(id);
  }

  async customer(_client: PoolClient, id: number): Promise<boolean> {
    return (await this.scope.customer(id))?.active ?? false;
  }

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
      callerPhone ?? (customerId === null ? null : (await this.scope.customer(customerId))?.phone);
    if (phone)
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('parcel-drafts.phone:'||$1::text,0))",
        [phone],
      );
  }

  draft(client: PoolClient, id: number, update = false) {
    return this.reads.draft(client, id, (query) => this.scope.readCalls(query), update);
  }

  async byClientId(client: PoolClient, callId: number | null, key: string) {
    const row = (
      await client.query<ParcelDraftRow>(
        `SELECT ${columns},creation_payload AS "creationPayload"
         FROM order_parcel_drafts d WHERE call_session_seq IS NOT DISTINCT FROM $1::int
         AND client_parcel_id=$2::uuid FOR UPDATE OF d`,
        [callId, key],
      )
    ).rows[0];
    if (!row) return;
    const ids = await availableDraftIds(
      client,
      'd.draft_seq=$1',
      [row.draftSeq],
      (query) => this.scope.readCalls(query),
      true,
    );
    const availability = (
      await client.query<{ unavailable: boolean }>(
        `SELECT NOT(${availableDraftSql(2, true)}) AS unavailable FROM order_parcel_drafts d WHERE d.draft_seq=$1`,
        [row.draftSeq, ids],
      )
    ).rows[0];
    return { ...row, unavailable: availability.unavailable };
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
      'UPDATE order_parcel_drafts SET parcel_data=$2::jsonb,status=$3,version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1',
      [id, JSON.stringify(parcel), status],
    );
  }

  bumpCall(_client: PoolClient, id: number) {
    return this.scope.bumpCall(id);
  }
}
