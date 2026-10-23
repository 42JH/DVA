import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  readonly pool = new Pool({
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectionTimeoutMillis: 2000,
    query_timeout: 5000,
    options: '-c statement_timeout=5000',
    max: 5,
  });

  constructor() {
    // An idle connection error must not crash the process or log query parameters.
    this.pool.on('error', () => console.error('Database connection unavailable.'));
  }

  async onModuleInit(): Promise<void> {
    const sql = readFileSync(join(__dirname, '../migrations/001-pbx-call-ended.sql'), 'utf8');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize first startup across multiple backend instances.
      await client.query('SELECT pg_advisory_xact_lock(20261023, 1)');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
