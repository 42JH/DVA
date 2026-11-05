import { createRelay, enqueue, sendEvent } from '@dva/events';
import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { AuditEvent, AuditResult } from './audit.types';

@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly pending = new WeakMap<
    PoolClient,
    { transactionId: string; eventIds: string[] }
  >();
  private readonly logger = new Logger(AuditService.name);
  private readonly relay: () => Promise<boolean>;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly url: string;
  private readonly token: string;

  constructor(
    private readonly database: DatabaseService,
    config: ConfigService<Environment, true>,
  ) {
    this.url = config.get('OPERATIONS_URL', { infer: true }) + '/internal/events';
    this.token = config.get('CUSTOMER_AUTH_TOKEN', { infer: true });
    this.relay = createRelay({
      pool: database.pool,
      source: 'customer',
      destinations: { operations: { url: this.url, token: this.token } },
    });
    database.audit = this;
  }
  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = this.relay()
          .then(() => undefined)
          .catch(() => {
            this.logger.error({ event: 'audit_delivery_unavailable' });
          })
          .finally(() => {
            this.running = undefined;
          });
    }, 250);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }

  async recordSuccess(event: AuditEvent, client: PoolClient): Promise<void> {
    return this.recordResult(event, 'SUCCESS', client);
  }
  async recordResult(event: AuditEvent, result: AuditResult, client: PoolClient): Promise<void> {
    const id = randomUUID();
    let pending = this.pending.get(client);
    if (!pending) {
      pending = { transactionId: randomUUID(), eventIds: [] };
      this.pending.set(client, pending);
      // This one transaction lock proves whether a crashed producer can still commit.
      await client.query('SELECT pg_advisory_xact_lock(20261106,hashtext($1))', [
        pending.transactionId,
      ]);
    }
    pending.eventIds.push(id);
    const at = (
      await client.query<{ at: Date }>('SELECT transaction_timestamp() AS at')
    ).rows[0].at.toISOString();
    await sendEvent(this.url, this.token, {
      eventId: id,
      source: 'customer',
      eventType: 'AuditPrepared',
      payload: {
        transactionId: pending.transactionId,
        audit: {
          ...event,
          actorType: event.actorType ?? (event.actorId === null ? 'SYSTEM' : 'ADMIN'),
        },
        result,
        occurredAt: at,
      },
    });
  }
  async recordFailure(event: AuditEvent, error: unknown): Promise<void> {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    try {
      await this.database.transaction((client) =>
        this.recordResult(event, [401, 403].includes(status) ? 'DENIED' : 'FAILED', client),
      );
    } catch {
      this.logger.error({ event: 'audit_write_failed', requestId: event.requestId });
    }
  }
  async beforeCommit(client: PoolClient): Promise<(() => Promise<void>) | undefined> {
    const pending = this.pending.get(client);
    if (!pending?.eventIds.length) return;
    let eventId: string | undefined;
    // Bound confirmation bodies when a company deletion produces thousands of audit rows.
    for (let offset = 0; offset < pending.eventIds.length; offset += 1000)
      eventId = await enqueue(client, {
        destination: 'operations',
        eventType: 'AuditCommitted',
        aggregateSeq: 1,
        payload: {
          transactionId: pending.transactionId,
          preparedEventIds: pending.eventIds.slice(offset, offset + 1000),
        },
      });
    return () => this.flush(eventId);
  }
  async rollback(client: PoolClient): Promise<void> {
    const pending = this.pending.get(client);
    if (!pending?.eventIds.length) return;
    await client.query('BEGIN');
    try {
      await enqueue(client, {
        destination: 'operations',
        eventType: 'AuditAborted',
        aggregateSeq: 1,
        payload: { transactionId: pending.transactionId },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  clear(client: PoolClient) {
    this.pending.delete(client);
  }

  async reconcile(transactionIds: string[]): Promise<void> {
    for (const transactionId of transactionIds)
      await this.database.transaction(async (client) => {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(20261106,hashtext($1)) AS locked',
          [transactionId],
        );
        if (!rows[0].locked) return;
        const committed = await client.query(
          "SELECT 1 FROM outbox_events WHERE event_type='AuditCommitted' AND payload->>'transactionId'=$1 LIMIT 1",
          [transactionId],
        );
        if (!committed.rowCount)
          await enqueue(client, {
            destination: 'operations',
            eventType: 'AuditAborted',
            aggregateSeq: 1,
            payload: { transactionId },
          });
      });
  }

  async flush(eventId?: string): Promise<void> {
    const deadline = Date.now() + 8000;
    while (
      (
        await this.database.pool.query(
          'SELECT 1 FROM outbox_events WHERE destination=$1 AND delivered_at IS NULL AND ($2::uuid IS NULL OR event_id=$2) LIMIT 1',
          ['operations', eventId ?? null],
        )
      ).rowCount
    ) {
      if (Date.now() >= deadline) throw new Error('Audit confirmation unavailable');
      await this.relay();
      await delay(25);
    }
  }
}
