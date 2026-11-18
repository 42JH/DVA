import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Environment } from '../config/environment';
import { PaymentCardsService } from './payment-cards.service';

@Injectable()
export class PaymentCardRevocationWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentCardRevocationWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly cards: PaymentCardsService,
  ) {}

  onApplicationBootstrap() {
    if (
      this.config.get('NODE_ENV') === 'test' ||
      !this.config.get('ORDER_PAYMENTS_ENABLED', { infer: true })
    )
      return;
    const tick = () => {
      if (this.stopped) return;
      void this.run();
      this.timer = setTimeout(tick, 5000);
      this.timer.unref();
    };
    tick();
  }

  run() {
    if (this.running) return this.running;
    this.running = this.work().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async work() {
    if (!this.config.get('ORDER_PAYMENTS_ENABLED', { infer: true })) return;
    try {
      await this.cards.revokeDeleted(randomUUID());
    } catch {
      this.logger.warn({ event: 'card_revocation_deferred' });
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => {});
  }
}
