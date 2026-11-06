import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';

@Injectable()
export class BillingWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BillingWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly billing: BillingService,
    private readonly config: ConfigService,
  ) {}
  onApplicationBootstrap() {
    if (this.config.get('NODE_ENV') === 'test') return;
    const tick = () => {
      if (!this.stopped) void this.run().catch(() => {});
    };
    this.timer = setInterval(tick, 10_000);
    this.timer.unref();
    tick();
  }
  run(now = new Date()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.billing
      .rollover(now)
      .catch((error) => {
        this.logger.error({ event: 'billing_rollover_failed' });
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
