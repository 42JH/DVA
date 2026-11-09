import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { CompleteOrderIntakeDto, ParcelConversionDto } from './dto/order-intake.dto';

@Injectable()
export class OrderIntakeRepository {
  constructor(private readonly database: DatabaseService) {}

  async seal(client: PoolClient, id: number, input: CompleteOrderIntakeDto) {
    await client.query(
      `UPDATE call_sessions SET order_completion_received_at=clock_timestamp(),order_completion_payload=$2::jsonb WHERE call_session_seq=$1`,
      [id, JSON.stringify(input)],
    );
  }

  async draftIds(client: PoolClient, id: number) {
    return (
      await client.query<{ id: number }>(
        `SELECT draft_seq AS id FROM order_parcel_drafts WHERE call_session_seq=$1 AND deleted_at IS NULL
      AND retention_started_at>statement_timestamp()-interval '5 years' ORDER BY draft_seq FOR UPDATE`,
        [id],
      )
    ).rows.map((row) => row.id);
  }

  async finish(
    client: PoolClient,
    id: number,
    orderSeq: number | null,
    mappings: ParcelConversionDto[],
  ) {
    for (const mapping of mappings)
      await client.query(
        `UPDATE order_parcel_drafts SET status='CONVERTED',order_parcel_seq=$2,order_seq=$3,version=version+1,updated_at=clock_timestamp() WHERE draft_seq=$1`,
        [mapping.draftSeq, mapping.orderParcelSeq, orderSeq],
      );
    await client.query(
      `UPDATE order_parcel_drafts SET status='INCOMPLETE',version=version+1,updated_at=clock_timestamp()
      WHERE call_session_seq=$1 AND status='EDITING' AND deleted_at IS NULL`,
      [id],
    );
    await client.query(
      `UPDATE call_sessions SET order_finalized_at=clock_timestamp(),order_finalization_result=$2::jsonb,
      order_finalization_error_code=NULL,order_finalization_attempted_at=clock_timestamp() WHERE call_session_seq=$1`,
      [id, JSON.stringify({ orderSeq, parcelMappings: mappings })],
    );
  }

  async failed(id: number, code: string) {
    await this.database.pool.query(
      `UPDATE call_sessions SET order_finalization_attempted_at=clock_timestamp(),order_finalization_error_code=$2
      WHERE call_session_seq=$1 AND order_finalized_at IS NULL AND order_completion_received_at IS NOT NULL`,
      [id, code],
    );
  }

  async candidates() {
    return (
      await this.database.pool.query<{
        id: number;
      }>(`SELECT call_session_seq AS id FROM call_sessions
      WHERE order_intake_enabled AND deleted_at IS NULL AND incoming_at>statement_timestamp()-interval '5 years'
       AND order_completion_received_at IS NOT NULL AND ended_at IS NOT NULL AND order_finalized_at IS NULL
       AND (order_finalization_attempted_at IS NULL OR order_finalization_attempted_at<=statement_timestamp()-interval '1 minute')
      ORDER BY order_finalization_attempted_at NULLS FIRST,call_session_seq LIMIT 20`)
    ).rows.map((row) => row.id);
  }
}
