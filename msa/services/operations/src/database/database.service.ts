import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { Environment } from '../config/environment';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
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
      new Logger(DatabaseService.name).error({ event: 'database_connection_unavailable' }),
    );
  }

  async onModuleInit(): Promise<void> {
    // Liquibase owns DDL; fail startup before accepting traffic on an incomplete schema.
    await this.pool.query('SELECT name, deleted_at FROM admin_users LIMIT 0');
    await this.pool.query('SELECT session_token_hash FROM admin_sessions LIMIT 0');
    await this.pool.query('SELECT actor_name, target_admin_name FROM audit_logs LIMIT 0');
    await this.pool.query('SELECT event_id FROM customer_audit_preparations LIMIT 0');
    await this.pool.query('SELECT event_id FROM consultation_audit_preparations LIMIT 0');
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const queued = performance.now();
    const client = await this.pool.connect();
    const started = performance.now();
    this.transactionStatistics.connectionWaitSeconds += (started - queued) / 1000;
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      this.transactionStatistics.failures++;
      try {
        await client.query('ROLLBACK');
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
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
