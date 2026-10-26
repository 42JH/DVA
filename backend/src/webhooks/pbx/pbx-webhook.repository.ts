import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class PbxWebhookRepository {
  constructor(private readonly database: DatabaseService) {}

  async insert(recordingId: string, payload: string): Promise<boolean> {
    const result = await this.database.pool.query(
      `INSERT INTO pbx_webhooks.call_ended_events (recording_id, payload)
       VALUES ($1, $2::jsonb) ON CONFLICT (recording_id) DO NOTHING RETURNING recording_id`,
      [recordingId, payload],
    );
    return result.rowCount === 1;
  }

  async hasSamePayload(recordingId: string, payload: string): Promise<boolean> {
    // A fresh READ COMMITTED snapshot sees the winning concurrent insert after it commits.
    const result = await this.database.pool.query<{ same: boolean }>(
      `SELECT payload = $2::jsonb AS same FROM pbx_webhooks.call_ended_events WHERE recording_id = $1`,
      [recordingId, payload],
    );
    return result.rows[0]?.same === true;
  }
}
