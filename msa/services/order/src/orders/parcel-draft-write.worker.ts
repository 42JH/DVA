import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRelay } from '@dva/events';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class ParcelDraftWriteWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ParcelDraftWriteWorker.name);
  private readonly relay: () => Promise<boolean>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<boolean>;
  private stopped = false;

  constructor(
    database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {
    this.relay = createRelay({
      pool: database.pool,
      source: 'order',
      destinations: {
        consultation: {
          url:
            config.get('CONSULTATION_URL', { infer: true }) + '/internal/parcel-draft-write/events',
          token: config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        },
      },
    });
  }

  onApplicationBootstrap() {
    if (this.config.get('NODE_ENV') === 'test') return;
    const tick = () => {
      if (this.stopped) return;
      void this.run().catch(() => this.logger.error({ event: 'draft_call_delivery_unavailable' }));
    };
    this.timer = setInterval(tick, 250);
    this.timer.unref();
    tick();
  }

  run(): Promise<boolean> {
    if (this.running) return this.running;
    this.running = this.relay().finally(() => {
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
