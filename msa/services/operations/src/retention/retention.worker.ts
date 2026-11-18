import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RetentionRepository } from './retention.repository';

@Injectable()
export class RetentionWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RetentionWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: RetentionRepository,
    private readonly config: ConfigService,
  ) {}

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
    if (!this.stopped) await this.repository.purgeDatabase();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
