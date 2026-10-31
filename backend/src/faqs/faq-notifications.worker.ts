import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { AiFaqClient } from './ai-faq.client';
import { FaqNotificationsRepository } from './faq-notifications.repository';

@Injectable()
export class FaqNotificationsWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(FaqNotificationsWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private stopped = false;

  constructor(
    private readonly repository: FaqNotificationsRepository,
    private readonly ai: AiFaqClient,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('AI_FAQ_TOKEN', { infer: true })) return;
    this.timer = setInterval(() => void this.run(), 5000);
    this.timer.unref();
    void this.run();
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.notify()
      .catch(() => this.logger.warn({ event: 'faq_notification_deferred' }))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  private async notify(): Promise<void> {
    if (!this.config.get('AI_FAQ_TOKEN', { infer: true })) return;
    for (let index = 0; index < 10 && !this.stopped; index++) {
      const pending = await this.repository.claim();
      if (!pending) return;
      try {
        await this.ai.notify(pending);
        await this.repository.finish(pending, true);
      } catch {
        await this.repository.finish(pending, false);
        this.logger.warn({ event: 'faq_notification_retry', eventId: pending.eventId });
        return;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
