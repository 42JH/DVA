import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PbxWebhookRepository } from './pbx-webhook.repository';
import { CallEndedPayload } from './pbx-webhook.payload';

@Injectable()
export class PbxWebhookService {
  constructor(private readonly repository: PbxWebhookRepository) {}

  async receive(
    payload: CallEndedPayload,
  ): Promise<{ status: string; recordingId: string; duplicate: boolean }> {
    try {
      const serialized = JSON.stringify(payload);
      const duplicate = !(await this.repository.insert(payload.recordingId, serialized));
      if (duplicate && !(await this.repository.hasSamePayload(payload.recordingId, serialized))) {
        throw new ConflictException('recordingId already exists with different data');
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
