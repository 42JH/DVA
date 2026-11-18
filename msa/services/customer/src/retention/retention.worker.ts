import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRelay } from '@dva/events';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { RetentionRepository } from './retention.repository';

@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RetentionWorker.name);
  private readonly relay?: () => Promise<boolean>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: RetentionRepository,
    database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {
    const url = config.get('ORDER_URL', { infer: true });
    if (url)
      this.relay = createRelay({
        pool: database.pool,
        source: 'customer',
        eventTypes: ['CustomerPaymentCardsPurged'],
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
    if (!(await this.repository.purgeDatabase())) return;
    for (let index = 0; index < 5 && !this.stopped; index++) if (!(await this.relay())) break;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
