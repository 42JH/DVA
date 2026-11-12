import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRelay } from '@dva/events';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { OrderRetentionRepository } from './order-retention.repository';

@Injectable()
export class OrderRetentionWorker implements OnModuleDestroy {
  private readonly logger = new Logger(OrderRetentionWorker.name);
  private readonly relay: () => Promise<boolean>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: OrderRetentionRepository,
    database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {
    this.relay = createRelay({
      pool: database.pool,
      source: 'order',
      eventTypes: ['OrderParcelsPurged'],
      destinations: {
        delivery: {
          url: config.get('DELIVERY_URL', { infer: true }) + '/internal/order-accepted',
          token: config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        },
      },
    });
  }

  start(): void {
    if (this.stopped || this.timer || this.config.get('NODE_ENV', { infer: true }) === 'test')
      return;
    const tick = () => void this.run().catch(() => {});
    this.timer = setInterval(tick, 10_000);
    this.timer.unref();
    tick();
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.work()
      .catch((error) => {
        this.logger.error({ event: 'order_retention_cleanup_failed' });
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async work(): Promise<void> {
    if (this.stopped || !(await this.repository.purgeDatabase())) return;
    for (let index = 0; index < 10 && !this.stopped; index++) if (!(await this.relay())) break;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
