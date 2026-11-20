import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { httpMetrics } from './http-metrics';

@Injectable()
export class ObservabilityService {
  constructor(private readonly database: DatabaseService) {}
  private pending?: Promise<string>;
  snapshot(): Promise<string> {
    // 동시 수집은 같은 읽기를 공유해 DB 장애 중 연결 요청이 쌓이지 않게 한다.
    this.pending ??= this.read().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async read(): Promise<string> {
    let databaseUp = 0;
    let ordersOk = 0;
    let orders: { status: string; count: string }[] = [];
    let stale = 0;
    try {
      await this.database.pool.query('SELECT 1');
      databaseUp = 1;
      await this.database.readSnapshot(async (client) => {
        await client.query("SET LOCAL statement_timeout = '2s'");
        orders = (
          await client.query<{ status: string; count: string }>(
            "SELECT status,count(*)::text AS count FROM orders WHERE status IN ('notPaid','PAID','SUBMISSION_FAILED','SUBMITTING_FAILED','SUBMITTING') AND deleted_at IS NULL GROUP BY status",
          )
        ).rows;
        stale = Number(
          (
            await client.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM orders WHERE status='SUBMITTING' AND deleted_at IS NULL AND COALESCE(submission_last_attempt_at,updated_at)<=statement_timestamp()-interval '10 seconds'",
            )
          ).rows[0].count,
        );
      });
      ordersOk = 1;
    } catch {
      /* SQL과 오류 본문 대신 수집 실패 지표를 제공한다. */
    }
    const lines = [
      httpMetrics().trimEnd(),
      '# TYPE dva_database_up gauge',
      `dva_database_up ${databaseUp}`,
      '# TYPE dva_order_metrics_success gauge',
      `dva_order_metrics_success ${ordersOk}`,
      '# TYPE dva_database_pool_connections gauge',
      `dva_database_pool_connections{state="total"} ${this.database.pool.totalCount}`,
      `dva_database_pool_connections{state="idle"} ${this.database.pool.idleCount}`,
      '# TYPE dva_database_pool_waiting_requests gauge',
      `dva_database_pool_waiting_requests ${this.database.pool.waitingCount}`,
      '# TYPE dva_database_transactions_total counter',
      `dva_database_transactions_total ${this.database.transactionStatistics.count}`,
      '# TYPE dva_database_transaction_failures_total counter',
      `dva_database_transaction_failures_total ${this.database.transactionStatistics.failures}`,
      '# TYPE dva_database_transaction_duration_seconds_total counter',
      `dva_database_transaction_duration_seconds_total ${this.database.transactionStatistics.seconds}`,
      '# TYPE dva_database_transaction_duration_seconds_max gauge',
      `dva_database_transaction_duration_seconds_max ${this.database.transactionStatistics.maxSeconds}`,
      '# TYPE dva_database_transaction_connection_wait_seconds_total counter',
      `dva_database_transaction_connection_wait_seconds_total ${this.database.transactionStatistics.connectionWaitSeconds}`,
    ];
    // 수집 실패를 주문 수 0으로 표시하지 않는다.
    if (ordersOk) {
      lines.push('# TYPE dva_orders_attention gauge');
      for (const status of [
        'notPaid',
        'PAID',
        'SUBMISSION_FAILED',
        'SUBMITTING_FAILED',
        'SUBMITTING',
      ])
        lines.push(
          `dva_orders_attention{status="${status}"} ${Number(orders.find((row) => row.status === status)?.count ?? 0)}`,
        );
      lines.push(
        '# TYPE dva_orders_stale_submitting gauge',
        `dva_orders_stale_submitting ${stale}`,
      );
    }
    return lines.join('\n') + '\n';
  }
}
