import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, PoolClient } from 'pg';
import { Environment } from '../config/environment';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly pool: Pool;

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
    const sql = readFileSync(join(__dirname, '../../migrations/001-pbx-call-ended.sql'), 'utf8');
    await this.transaction(async (client) => {
      // Preserve the existing additive PBX startup migration, serialized across instances.
      await client.query('SELECT pg_advisory_xact_lock(20261023, 1)');
      await client.query(sql);
    });
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Evict a broken connection while preserving the original business/SQL failure.
        releaseError = new Error('Transaction rollback failed');
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
