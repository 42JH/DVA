import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderSubmissionService } from './order-submission.service';

@Injectable()
export class OrderSubmissionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderSubmissionWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly submissions: OrderSubmissionService,
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

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.submissions
      .recoverPending()
      .then(() => this.submissions.recoverPaid())
      .catch((error) => {
        this.logger.error({ event: 'order_submission_recovery_failed' });
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
