import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { OrganizationBillingService } from '../organizations/organization-billing.service';
import { OrderSubmissionService } from './order-submission.service';
import { OrderSubmissionRepository } from './order-submission.repository';
import { OrdersRepository } from './orders.repository';
import { OrderPaymentsRepository } from './order-payments.repository';
import { OrderIntakeService } from './order-intake.service';

@Injectable()
export class OrderMaintenanceWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OrderMaintenanceWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | null = null;
  private stopped = false;
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly billing: OrganizationBillingService,
    private readonly submissions: OrderSubmissionService,
    private readonly submissionRepository: OrderSubmissionRepository,
    private readonly repository: OrdersRepository,
    private readonly payments: OrderPaymentsRepository,
    private readonly config: ConfigService,
    private readonly intake: OrderIntakeService,
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
    this.running = this.work(now)
      .catch((error) => {
        this.logger.error({ event: 'order_maintenance_failed' });
        throw error;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
  private async work(now: Date) {
    await this.intake.recoverPending();
    await this.submissions.recoverPending();
    // Rollover commits before locking orders, preserving the payment lock order.
    await this.billing.rollover(now);
    for (let batch = 0; batch < 10 && !this.stopped; batch++) {
      const count = await this.database.transaction(async (client) => {
        const pending = await this.payments.lockExpiredOrders(client, now);
        for (const order of pending) {
          await this.repository.cancel(client, order.orderSeq);
          await this.repository.recalculateAmount(client, order.orderSeq);
          await this.payments.replaceRequest(client, order.orderSeq);
          await this.audit.recordSuccess(
            {
              actorId: null,
              actorType: 'SYSTEM',
              targetId: order.orderSeq,
              targetType: 'ORDER',
              action: 'ORDER_CANCELLED',
              requestId: randomUUID(),
              metadata: {
                amountBefore: order.totalAmount,
                amountAfter: 0,
                reason: 'PAYMENT_EXPIRED',
              },
            },
            client,
          );
        }
        return pending.length;
      });
      if (count < 10) break;
    }
    const pending = await this.submissionRepository.retryCandidates(this.database.pool);
    await Promise.all(
      pending.map(async (order) => {
        try {
          await this.submissions.submitPaidOrder(
            order.id,
            randomUUID(),
            null,
            order.status === 'SUBMITTING_FAILED',
            order.updatedAt,
          );
        } catch {
          this.logger.error({ event: 'paid_order_submission_deferred', orderSeq: order.id });
        }
      }),
    );
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running?.catch(() => {});
  }
}
