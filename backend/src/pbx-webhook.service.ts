import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { CallEndedPayload } from './pbx-webhook.payload';

@Injectable()
export class PbxWebhookService {
  constructor(private readonly database: DatabaseService) {}

  async receive(payload: CallEndedPayload): Promise<{ status: string; recordingId: string; duplicate: boolean }> {
    try {
      const serialized = JSON.stringify(payload);
      const inserted = await this.database.pool.query(
        `INSERT INTO pbx_webhooks.call_ended_events (recording_id, payload)
         VALUES ($1, $2::jsonb) ON CONFLICT (recording_id) DO NOTHING RETURNING recording_id`,
        [payload.recordingId, serialized],
      );
      const duplicate = inserted.rowCount === 0;
      if (duplicate) {
        // A separate statement gets a fresh READ COMMITTED snapshot after a concurrent insert commits.
        const previous = await this.database.pool.query<{ same: boolean }>(
          `SELECT payload = $2::jsonb AS same FROM pbx_webhooks.call_ended_events WHERE recording_id = $1`,
          [payload.recordingId, serialized],
        );
        if (!previous.rows[0]?.same) throw new ConflictException('recordingId already exists with different data');
      }
      // INSERT autocommit completes before the acknowledgment. Never ACK a failed database write.
      return { status: 'received', recordingId: payload.recordingId, duplicate };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      // Do not expose/log phone numbers, signed download URLs, SQL parameters or credentials.
      throw new ServiceUnavailableException('Webhook storage unavailable; retry later');
    }
  }
}
