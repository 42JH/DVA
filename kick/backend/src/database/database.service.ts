import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool, type QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly pool = new Pool({
    connectionTimeoutMillis: 2_000,
    query_timeout: 2_000,
  });

  constructor() {
    this.pool.on('error', () => this.logger.warn('Idle PostgreSQL connection failed'));
  }

  async checkConnection(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  query<T extends QueryResultRow>(sql: string, parameters: unknown[] = []) {
    return this.pool.query<T>(sql, parameters);
  }

  async onModuleInit(): Promise<void> {
    const directory = join(__dirname, '../../migrations');
    const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(7013010)');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY)');
      const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
      const applied = new Set(rows.map(({ name }) => name));
      for (const file of files) {
        if (!applied.has(file)) {
          await client.query(await readFile(join(directory, file), 'utf8'));
          await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
