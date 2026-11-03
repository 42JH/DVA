import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { OrganizationBillingService } from '../organizations/organization-billing.service';
import { OrderSubmissionService } from './order-submission.service';
import { OrdersRepository } from './orders.repository';
import { OrderPaymentsRepository } from './order-payments.repository';

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
    private readonly repository: OrdersRepository,
    private readonly payments: OrderPaymentsRepository,
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
    await this.submissions.recoverPending();
    // Rollover commits before locking orders, preserving the payment lock order.
    await this.billing.rollover(now);
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
        return pending.rows.length;
      });
      if (count < 10) break;
    }
    const pending = await this.database.pool.query<{
      id: number;
      status: 'PAID' | 'SUBMITTING_FAILED';
      updatedAt: string;
    }>(
      `SELECT order_seq AS id,status,updated_at::text AS "updatedAt" FROM orders
       WHERE deleted_at IS NULL AND COALESCE(closed_at,created_at)>statement_timestamp()-interval '5 years'
        AND (submission_first_attempt_at IS NULL OR submission_first_attempt_at>statement_timestamp()-interval '10 minutes')
        AND (submission_last_attempt_at IS NULL OR submission_last_attempt_at<=statement_timestamp()-interval '1 minute')
        AND status IN ('PAID','SUBMITTING_FAILED')
       ORDER BY submission_last_attempt_at NULLS FIRST,order_seq LIMIT 20`,
    );
    await Promise.all(
      pending.rows.map(async (order) => {
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
