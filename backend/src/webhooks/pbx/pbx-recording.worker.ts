import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Environment } from '../../config/environment';
import { PbxWebhookRepository } from './pbx-webhook.repository';
import { parseCallEndedPayload } from './pbx-webhook.payload';
import { RecordingStorage } from './recording-storage';

@Injectable()
export class PbxRecordingWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PbxRecordingWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: PbxWebhookRepository,
    private readonly storage: RecordingStorage,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.storage.configured) {
      this.logger.warn({ event: 'recording_storage_unconfigured' });
      return;
    }
    const tick = () => {
      if (this.stopped || this.running) return;
      this.running = this.processPending()
        .catch(() => this.logger.error({ event: 'recording_worker_unavailable' }))
        .finally(() => {
          this.running = undefined;
        });
    };
    this.timer = setInterval(tick, 10000);
    this.timer.unref();
    tick();
  }

  async processPending(): Promise<void> {
    if (!this.storage.configured) return;
    for (let index = 0; index < 5 && !this.stopped; index++) {
      const event = await this.repository.next();
      if (!event) break;
      try {
        const payload = parseCallEndedPayload(event.payload);
        const callId = await this.repository.match(
          payload,
          this.config.get('RECORDING_MATCH_WINDOW_SECONDS', { infer: true }),
          event.claimId,
        );
        if (callId === null) {
          await this.repository.release(event.recordingId, event.claimId);
          continue;
        }
        const key = await this.storage.save(event.recordingId, callId, payload.recordingUrl);
        await this.repository.processed(event.recordingId, callId, key, event.claimId);
      } catch {
        await this.repository.failed(event.recordingId, event.claimId);
        this.logger.warn({
          event: 'recording_processing_failed',
          receipt: createHash('sha256').update(event.recordingId).digest('hex'),
        });
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
