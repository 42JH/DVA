import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../../database/database.service';
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
    private readonly database: DatabaseService,
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
    const lock = await this.database.pool.connect();
    let acquired = false;
    let releaseError: Error | undefined;
    const connectionError = () => {
      releaseError = new Error('recording_worker_connection_failed');
    };
    lock.on('error', connectionError);
    try {
      acquired = (
        await lock.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(20261027, 1) AS acquired',
        )
      ).rows[0].acquired;
      if (!acquired) return;
      for (let index = 0; index < 5 && !this.stopped && !releaseError; index++) {
        const event = await this.repository.next(lock);
        if (!event) break;
        try {
          const payload = parseCallEndedPayload(event.payload);
          const callId = await this.repository.match(
            payload,
            this.config.get('RECORDING_MATCH_WINDOW_SECONDS', { infer: true }),
          );
          if (callId === null) continue;
          const key = await this.storage.save(event.recordingId, callId, payload.recordingUrl);
          await this.repository.processed(event.recordingId, callId, key);
        } catch {
          await this.repository.failed(event.recordingId);
          this.logger.warn({
            event: 'recording_processing_failed',
            receipt: createHash('sha256').update(event.recordingId).digest('hex'),
          });
        }
      }
    } finally {
      if (acquired) {
        try {
          await lock.query('SELECT pg_advisory_unlock(20261027, 1)');
        } catch {
          releaseError = new Error('recording_worker_unlock_failed');
        }
      }
      lock.off('error', connectionError);
      lock.release(releaseError);
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
