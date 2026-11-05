import { HttpException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReceiver, sendEvent, type Event } from '@dva/events';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { AuditRepository } from './audit.repository';
import { AUDIT_ACTOR_TYPES, AUDIT_RESULTS, type AuditEvent, type AuditResult } from './audit.types';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = (value: unknown) =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const invalid = () => new HttpException({ error: 'INVALID_AUDIT_EVENT' }, 422);
const actions = new Set([
  'CUSTOMER_CREATED',
  'ORGANIZATION_CREATED',
  'ORGANIZATION_UPDATED',
  'ORGANIZATION_DELETED',
  'DEPARTMENT_CREATED',
  'DEPARTMENT_UPDATED',
  'DEPARTMENT_DELETED',
  'MEMBERSHIP_CREATED',
  'MEMBERSHIP_UPDATED',
  'MEMBERSHIP_REMOVED',
  'MEMBERS_IMPORTED',
  'COMPANY_PIN_UPDATED',
  'COMPANY_PIN_DELETED',
]);
const targets = new Set(['CUSTOMER', 'ORGANIZATION', 'DEPARTMENT', 'MEMBERSHIP', 'COMPANY_PIN']);
function auditInput(payload: Record<string, unknown>, service: 'customer' | 'consultation') {
  const audit = payload.audit;
  if (
    Object.keys(payload).sort().join(',') !== 'audit,occurredAt,result,transactionId' ||
    !object(audit) ||
    Object.keys(audit).some(
      (key) =>
        ![
          'actorId',
          'actorType',
          'actorName',
          'action',
          'targetId',
          'targetType',
          'requestId',
          'metadata',
        ].includes(key),
    ) ||
    !(
      audit.actorName === undefined ||
      (typeof audit.actorName === 'string' && audit.actorName.length <= 400)
    ) ||
    !(audit.actorId === null || integer(audit.actorId)) ||
    !(audit.targetId === null || integer(audit.targetId)) ||
    !AUDIT_ACTOR_TYPES.includes(audit.actorType as never) ||
    (audit.actorType === 'ADMIN') !== (audit.actorId !== null) ||
    !(service === 'customer'
      ? actions.has(audit.action as string)
      : audit.action === 'CALL_STARTED') ||
    !(service === 'customer'
      ? targets.has(audit.targetType as string)
      : audit.targetType === 'CALL_SESSION') ||
    typeof audit.requestId !== 'string' ||
    audit.requestId.length < 1 ||
    audit.requestId.length > 128 ||
    !(audit.metadata === undefined || object(audit.metadata)) ||
    !AUDIT_RESULTS.includes(payload.result as never) ||
    (service === 'consultation' &&
      (payload.result !== 'SUCCESS' ||
        audit.targetId === null ||
        !['AI', 'ADMIN'].includes(audit.actorType as string))) ||
    typeof payload.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.occurredAt))
  )
    throw invalid();
  return {
    audit: audit as unknown as AuditEvent,
    result: payload.result as AuditResult,
    at: payload.occurredAt,
    transactionId: transaction(payload),
  };
}
function references(payload: Record<string, unknown>): string[] {
  if (
    Object.keys(payload).sort().join(',') !== 'preparedEventIds,transactionId' ||
    !Array.isArray(payload.preparedEventIds) ||
    payload.preparedEventIds.length < 1 ||
    payload.preparedEventIds.length > 10000 ||
    payload.preparedEventIds.some((value) => typeof value !== 'string' || !uuid.test(value)) ||
    new Set(payload.preparedEventIds).size !== payload.preparedEventIds.length
  )
    throw invalid();
  return payload.preparedEventIds as string[];
}
function transaction(payload: Record<string, unknown>): string {
  if (typeof payload.transactionId !== 'string' || !uuid.test(payload.transactionId))
    throw invalid();
  return payload.transactionId;
}

@Injectable()
export class ServiceAuditReceiver {
  readonly receive: ReturnType<typeof createReceiver>;
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    repository: AuditRepository,
  ) {
    const sources: Record<string, string> = {};
    const handlers: Record<string, (client: PoolClient, event: Event) => Promise<void>> = {};
    for (const service of ['customer', 'consultation'] as const) {
      const table =
        service === 'customer' ? 'customer_audit_preparations' : 'consultation_audit_preparations';
      const token = config.get(
        service === 'customer' ? 'CUSTOMER_AUTH_TOKEN' : 'CONSULTATION_AUTH_TOKEN',
        { infer: true },
      );
      if (token) sources[service] = token;
      Object.assign(handlers, {
        [service + ':AuditPrepared']: async (client: PoolClient, event: Event) => {
          const input = auditInput(event.payload, service);
          await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [
            input.transactionId,
          ]);
          const existing = await client.query<{ aborted: boolean }>(
            `SELECT aborted FROM ${table} WHERE event_id=$1`,
            [input.transactionId],
          );
          if (existing.rows[0]?.aborted) return;
          await repository.insert(input.audit, input.result, client, input.at);
          await client.query(
            `WITH prepared AS (
          DELETE FROM audit_logs WHERE audit_log_seq=currval(pg_get_serial_sequence('audit_logs','audit_log_seq')) RETURNING *
        ) INSERT INTO ${table}(event_id,transaction_id,audit) SELECT $1,$2,to_jsonb(prepared) FROM prepared`,
            [event.eventId, input.transactionId],
          );
        },
        [service + ':AuditCommitted']: async (client: PoolClient, event: Event) => {
          const ids = references(event.payload);
          const transactionId = transaction(event.payload);
          await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [
            transactionId,
          ]);
          const prepared = await client.query(
            `SELECT event_id FROM ${table} WHERE event_id=ANY($1::uuid[]) AND transaction_id=$2 AND NOT aborted FOR UPDATE`,
            [ids, transactionId],
          );
          if (prepared.rowCount !== ids.length) throw invalid();
          await client.query(
            `INSERT INTO audit_logs OVERRIDING SYSTEM VALUE
          SELECT (jsonb_populate_record(NULL::audit_logs,p.audit)).* FROM unnest($1::uuid[]) WITH ORDINALITY i(id,n)
          JOIN ${table} p ON p.event_id=i.id ORDER BY i.n`,
            [ids],
          );
          await client.query(`DELETE FROM ${table} WHERE event_id=ANY($1::uuid[])`, [ids]);
        },
        [service + ':AuditAborted']: async (client: PoolClient, event: Event) => {
          if (Object.keys(event.payload).join(',') !== 'transactionId') throw invalid();
          const transactionId = transaction(event.payload);
          await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [
            transactionId,
          ]);
          await client.query(
            `UPDATE ${table} SET audit=NULL,aborted=true WHERE transaction_id=$1`,
            [transactionId],
          );
          await client.query(
            `INSERT INTO ${table}(event_id,transaction_id,aborted) VALUES($1,$1,true)
            ON CONFLICT(event_id) DO UPDATE SET audit=NULL,aborted=true WHERE ${table}.transaction_id=EXCLUDED.transaction_id`,
            [transactionId],
          );
        },
      });
    }
    this.receive = createReceiver<PoolClient>({ pool: database.pool, sources, handlers });
  }

  async flushPending(): Promise<void> {
    for (const service of ['customer', 'consultation'] as const) {
      const table =
        service === 'customer' ? 'customer_audit_preparations' : 'consultation_audit_preparations';
      const { rows } = await this.database.pool.query<{ transaction_id: string }>(
        `SELECT DISTINCT transaction_id FROM ${table} WHERE NOT aborted ORDER BY transaction_id LIMIT 128`,
      );
      if (!rows.length) continue;
      const url = this.config.get(service === 'customer' ? 'CUSTOMER_URL' : 'CONSULTATION_URL', {
        infer: true,
      });
      const token = this.config.get(
        service === 'customer' ? 'CUSTOMER_AUTH_TOKEN' : 'CONSULTATION_AUTH_TOKEN',
        { infer: true },
      );
      if (!url || !token) throw new Error('Customer audit confirmation unavailable');
      await sendEvent(url + '/internal/audit/flush', token, {
        eventId: randomUUID(),
        source: 'operations',
        eventType: 'AuditFlushRequested',
        payload: { transactionIds: rows.map((row) => row.transaction_id) },
      });
    }
  }
}
