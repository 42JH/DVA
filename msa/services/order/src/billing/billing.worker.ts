import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { BillingService } from './billing.service';

@Injectable()
export class BillingWorker implements OnModuleDestroy {
  private running?: Promise<void>;
  constructor(private readonly billing: BillingService) {}
  run(now = new Date()): Promise<void> {
    if (this.running) return this.running;
    this.running = this.billing.rollover(now).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async onModuleDestroy() {
    await this.running?.catch(() => {});
  }
}
