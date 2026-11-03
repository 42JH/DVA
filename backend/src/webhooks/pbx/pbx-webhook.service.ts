import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PbxWebhookRepository } from './pbx-webhook.repository';
import { CallEndedPayload } from './pbx-webhook.payload';

@Injectable()
export class PbxWebhookService {
  private readonly logger = new Logger(PbxWebhookService.name);
  constructor(private readonly repository: PbxWebhookRepository) {}

  async receive(
    payload: CallEndedPayload,
  ): Promise<{ status: string; recordingId: string; duplicate: boolean }> {
    try {
      if (await this.repository.expired(payload.startedAt))
        return { status: 'expired', recordingId: payload.recordingId, duplicate: false };
      const serialized = JSON.stringify(payload);
      const duplicate = !(await this.repository.insert(payload.recordingId, serialized));
      if (duplicate && !(await this.repository.hasSamePayload(payload.recordingId, serialized))) {
        throw new ConflictException('recordingId already exists with different data');
      }
      try {
        await this.repository.matchReceived(payload);
      } catch {
        // 수신은 이미 영속화했다. 종료 매칭 장애는 기존 워커가 수신 건으로 복구한다.
        this.logger.warn({ event: 'call_end_matching_deferred' });
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
