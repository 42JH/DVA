import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { PaymentsService } from './payments.service';
import { PaymentsRepository } from './payments.repository';
import { randomUUID } from 'node:crypto';
@Injectable()
export class PaymentsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly payments: PaymentsService,
    private readonly repository: PaymentsRepository,
  ) {}
  onApplicationBootstrap() {
    if (
      this.config.get('NODE_ENV') === 'test' ||
      !this.config.get('ORDER_PAYMENTS_ENABLED', { infer: true })
    )
      return;
    const tick = () => {
      if (this.stopped) return;
      void this.run().catch(() => this.logger.error({ event: 'payment_worker_failed' }));
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
    for (let i = 0; i < 10; i++) if (!(await this.payments.notifyCompletionOne())) break;
    for (let i = 0; i < 10; i++) if (!(await this.payments.notifyOne())) break;
    for (const { id } of await this.repository.pendingApprovals()) {
      try {
        await this.payments.reconcile(id, randomUUID());
      } catch {
        this.logger.warn({ event: 'payment_reconcile_deferred' });
      }
    }
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => {});
  }
}
