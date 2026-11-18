import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRelay } from '@dva/events';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { RecordingStorage } from '../webhooks/pbx/recording-storage';
import { RetentionRepository } from './retention.repository';

@Injectable()
export class RetentionWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RetentionWorker.name);
  private readonly relay?: () => Promise<boolean>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: RetentionRepository,
    private readonly storage: RecordingStorage,
    private readonly config: ConfigService<Environment, true>,
    database: DatabaseService,
  ) {
    const url = config.get('ORDER_URL', { infer: true });
    if (url)
      this.relay = createRelay({
        pool: database.pool,
        source: 'consultation',
        eventTypes: ['ConsultationCallsPurged'],
        destinations: {
          order: {
            url: url + '/internal/call-read-references/events',
            token: config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
          },
        },
      });
  }

  onApplicationBootstrap(): void {
    if (this.config.get('NODE_ENV') === 'test') return;
    const tick = () => void this.run().catch(() => {});
    this.timer = setInterval(tick, 10_000);
    this.timer.unref();
    tick();
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.work()
      .catch((error) => {
        this.logger.error({ event: 'retention_cleanup_failed' });
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async work(): Promise<void> {
    if (this.stopped) return;
    if (!this.relay) throw new Error('Order owner unavailable');
    for (let index = 0; index < 5 && !this.stopped; index++) {
      const claim = await this.repository.claimCall();
      if (!claim) break;
      try {
        for (const key of claim.keys) {
          if (!(await this.repository.renew(claim)))
            throw new Error('retention_claim_lost');
          await this.storage.erase(key);
        }
        if (!(await this.repository.finishCall(claim)))
          await this.repository.defer(claim);
      } catch {
        await this.repository.defer(claim);
        this.logger.error({ event: 'retention_recording_deferred' });
      }
    }
    for (let index = 0; index < 5 && !this.stopped; index++)
      if (!(await this.relay())) break;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
