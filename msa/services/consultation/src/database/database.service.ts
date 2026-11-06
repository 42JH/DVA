import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { type Environment } from '../config/environment';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  audit?: {
    beforeCommit(
      client: PoolClient,
    ): Promise<(() => Promise<void>) | undefined>;
    rollback(client: PoolClient): Promise<void>;
    clear(client: PoolClient): void;
  };
  readonly pool: Pool;
  readonly transactionStatistics = {
    count: 0,
    failures: 0,
    seconds: 0,
    maxSeconds: 0,
    connectionWaitSeconds: 0,
  };

  constructor(config: ConfigService<Environment, true>) {
    this.pool = new Pool({
      host: config.get('DB_HOST', { infer: true }),
      port: config.get('DB_PORT', { infer: true }),
      user: config.get('DB_USER', { infer: true }),
      password: config.get('DB_PASSWORD', { infer: true }),
      database: config.get('DB_NAME', { infer: true }),
      connectionTimeoutMillis: 2000,
      query_timeout: 5000,
      options: '-c statement_timeout=5000',
      max: 5,
    });
    // An idle connection error must not crash the process or log query parameters.
    this.pool.on('error', () =>
      new Logger(DatabaseService.name).error({
        event: 'database_connection_unavailable',
      }),
    );
  }

  async onModuleInit(): Promise<void> {
    // Liquibase owns DDL; fail startup before accepting traffic on an incomplete schema.
    await this.pool.query(
      'SELECT incoming_at,registered_at,deleted_at,customer_seq FROM call_sessions LIMIT 0',
    );
    await this.pool.query(
      'SELECT claim_id,claimed_until,call_session_seq FROM pbx_webhooks.call_ended_events LIMIT 0',
    );
    await this.pool.query('SELECT object_key FROM recordings LIMIT 0');
    await this.pool.query(
      'SELECT ai_persona_version_seq,has_callback_request FROM call_analyses LIMIT 0',
    );
    await this.pool.query(
      'SELECT response_wait_payload_hash FROM call_dashboard_metrics LIMIT 0',
    );
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const queued = performance.now();
    const client = await this.pool.connect();
    const started = performance.now();
    this.transactionStatistics.connectionWaitSeconds +=
      (started - queued) / 1000;
    let releaseError: Error | undefined;
    let commitAttempted = false;
    let completed!: T;
    let confirmed: (() => Promise<void>) | undefined;
    try {
      await client.query('BEGIN');
      completed = await work(client);
      confirmed = await this.audit?.beforeCommit(client);
      commitAttempted = true;
      await client.query('COMMIT');
    } catch (error) {
      this.transactionStatistics.failures++;
      try {
        await client.query('ROLLBACK');
        // A lost COMMIT response may already be committed; never publish an abort for it.
        if (!commitAttempted) await this.audit?.rollback(client);
      } catch {
        // Evict a broken connection while preserving the original business/SQL failure.
        releaseError = new Error('Transaction rollback failed');
      }
      throw error;
    } finally {
      const seconds = (performance.now() - started) / 1000;
      this.transactionStatistics.count++;
      this.transactionStatistics.seconds += seconds;
      this.transactionStatistics.maxSeconds = Math.max(
        this.transactionStatistics.maxSeconds,
        seconds,
      );
      client.release(releaseError);
      this.audit?.clear(client);
    }
    // Release the business connection before the relay needs another pool connection.
    await confirmed?.();
    return completed;
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
