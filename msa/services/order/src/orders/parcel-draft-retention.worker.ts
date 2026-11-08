import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';

@Injectable()
export class ParcelDraftRetentionWorker implements OnModuleDestroy {
  private readonly logger = new Logger(ParcelDraftRetentionWorker.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  start(): void {
    if (this.config.get('NODE_ENV', { infer: true }) === 'test') return;
    const tick = () => void this.run().catch(() => {});
    this.timer = setInterval(tick, 10_000);
    this.timer.unref();
    tick();
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.database
      .transaction(async (client) => {
        for (const [key, value] of [
          [20261103, 157],
          [20261027, 37],
        ])
          if (
            !(
              await client.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_xact_lock($1,$2) AS locked',
                [key, value],
              )
            ).rows[0].locked
          )
            return;
        await client.query("SET LOCAL lock_timeout='1s'");
        await client.query(`DELETE FROM order_parcel_drafts WHERE draft_seq IN (
        SELECT draft_seq FROM order_parcel_drafts WHERE retention_started_at<=statement_timestamp()-interval '5 years'
        ORDER BY retention_started_at,draft_seq LIMIT 100 FOR UPDATE SKIP LOCKED)`);
      })
      .catch((error) => {
        this.logger.error({ event: 'parcel_draft_retention_cleanup_failed' });
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => {});
  }
}
