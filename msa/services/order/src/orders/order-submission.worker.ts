import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { BillingWorker } from '../billing/billing.worker';
import { DatabaseService } from '../database/database.service';
import { OrdersRepository } from './orders.repository';
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
    private readonly database: DatabaseService,
    private readonly repository: OrdersRepository,
    private readonly audit: AuditService,
    private readonly billing: BillingWorker,
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
        this.running = undefined;
      });
    return this.running;
  }

  private async work(now: Date) {
    await this.submissions.recoverPending();
    await this.billing.run(now);
    await this.expireUnpaid(now);
    await this.submissions.recoverPaid();
  }

  private async expireUnpaid(now: Date) {
    for (let batch = 0; batch < 10 && !this.stopped; batch++) {
      const count = await this.database.transaction(async (client) => {
        if (
          !(
            await client.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_xact_lock(20261030,140) AS locked',
            )
          ).rows[0].locked
        )
          return 0;
        const pending = await client.query<{ orderSeq: number; totalAmount: number }>(
          `SELECT o.order_seq AS "orderSeq",o.total_amount AS "totalAmount" FROM orders o
       WHERE status='notPaid' AND o.deleted_at IS NULL AND payment_due_at<=$1 AND NOT EXISTS(SELECT 1 FROM order_payment_requests r WHERE r.order_seq=o.order_seq AND r.invalidated_at IS NULL AND r.completed_at IS NULL AND r.approval_started_at IS NOT NULL)
       ORDER BY payment_due_at,order_seq LIMIT 10 FOR UPDATE OF o SKIP LOCKED`,
          [now],
        );
        for (const order of pending.rows) {
          await this.repository.cancel(client, order.orderSeq);
          await this.repository.recalculateAmount(client, order.orderSeq);
          await this.repository.replaceRequest(client, order.orderSeq);
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
        return pending.rows.length;
      });
      if (count < 10) break;
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
