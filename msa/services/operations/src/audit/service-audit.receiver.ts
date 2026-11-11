import { HttpException, Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReceiver, sendEvent, type Event } from '@dva/events';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { AuditRepository } from './audit.repository';
import { ApiException } from '../common/errors/api.exception';
import { AUDIT_ACTOR_TYPES, AUDIT_RESULTS, type AuditEvent, type AuditResult } from './audit.types';
import {
  assembleFaqExamples,
  validateFaqChunks,
  validateFaqExamples,
  type FaqExamplesPayload,
} from '@dva/events/faq-question-examples.cjs';
import {
  commitFaqExamples,
  isFaqExamplesPreparation,
  prepareFaqExamples,
} from '../faqs/faq-question-examples';
import { validateFaqConversionEvent } from '@dva/events/faq-conversion.cjs';
import {
  prepareFaqConversion,
  commitFaqConversion,
  isFaqConversionPreparation,
} from '../faqs/faq-conversion';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const integer = (value: unknown) =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const invalid = () => new HttpException({ error: 'INVALID_AUDIT_EVENT' }, 422);
const actions = new Set([
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_DELETED',
  'PERSONAL_PIN_CREATED',
  'PERSONAL_PIN_UPDATED',
  'PERSONAL_PIN_DELETED',
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
const targets = new Set([
  'CUSTOMER',
  'PERSONAL_PIN',
  'ORGANIZATION',
  'DEPARTMENT',
  'MEMBERSHIP',
  'COMPANY_PIN',
]);
const consultationActions = new Set([
  'CALL_STARTED',
  'CALL_DELETED',
  'UNANSWERED_QUESTION_RECORDED',
  'UNANSWERED_QUESTION_DELETED',
  'UNANSWERED_QUESTION_REGISTERED',
  'CALL_ANALYSIS_RECORDED',
  'CALL_ANALYSIS_FAILED',
  'CALL_EVENTS_RECORDED',
  'CALL_DROPOFF_RECORDED',
  'CALL_RESPONSE_WAIT_RECORDED',
]);
function auditInput(
  payload: Record<string, unknown>,
  service: 'customer' | 'consultation' | 'order',
) {
  const audit = payload.audit;
  const billingInitialization =
    service === 'order' && object(audit) && audit.action === 'BILLING_MONTH_INITIALIZED';
  const paymentCompleted =
    service === 'order' && object(audit) && audit.action === 'ORDER_PAYMENT_COMPLETED';
  const submission =
    service === 'order' &&
    object(audit) &&
    [
      'ORDER_SUBMISSION_STARTED',
      'ORDER_RESUBMISSION_STARTED',
      'ORDER_SUBMISSION_ACCEPTED',
      'ORDER_SUBMISSION_FAILED',
    ].includes(audit.action as string);
  const personaReference =
    service === 'consultation' &&
    object(audit) &&
    audit.action === 'CALL_ANALYSIS_RECORDED' &&
    payload.result === 'SUCCESS' &&
    Object.hasOwn(payload, 'personaVersionSeq');
  if (
    Object.keys(payload).sort().join(',') !==
      (personaReference
        ? 'audit,occurredAt,personaVersionSeq,result,transactionId'
        : 'audit,occurredAt,result,transactionId') ||
    (personaReference && !integer(payload.personaVersionSeq)) ||
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
      : service === 'order'
        ? submission ||
          paymentCompleted ||
          [
            'BILLING_MONTH_INITIALIZED',
            'ORDER_DELETED',
            'PARCEL_DRAFT_DELETED',
            'ORDER_CANCELLED',
            'ORDER_PARCEL_CANCELLED',
            'ORDER_AMOUNT_CHANGED',
            'ORDER_PAYMENT_NOTIFICATION_RETRIED',
            'ORDER_PAYMENT_COMPLETION_NOTIFICATION_RETRIED',
          ].includes(audit.action as string)
        : consultationActions.has(audit.action as string)) ||
    !(service === 'customer'
      ? targets.has(audit.targetType as string)
      : service === 'order'
        ? audit.targetType ===
          (billingInitialization
            ? 'ORGANIZATION'
            : audit.action === 'PARCEL_DRAFT_DELETED'
              ? 'ORDER_PARCEL_DRAFT'
              : audit.action === 'ORDER_PARCEL_CANCELLED' && payload.result === 'SUCCESS'
                ? 'ORDER_PARCEL'
                : 'ORDER')
        : audit.targetType ===
          ([
            'UNANSWERED_QUESTION_RECORDED',
            'UNANSWERED_QUESTION_DELETED',
            'UNANSWERED_QUESTION_REGISTERED',
          ].includes(audit.action as string)
            ? 'UNANSWERED_QUESTION'
            : 'CALL_SESSION')) ||
    typeof audit.requestId !== 'string' ||
    audit.requestId.length < 1 ||
    audit.requestId.length > 128 ||
    !(audit.metadata === undefined || object(audit.metadata)) ||
    !AUDIT_RESULTS.includes(payload.result as never) ||
    (service === 'consultation' &&
      audit.action === 'CALL_STARTED' &&
      (payload.result !== 'SUCCESS' ||
        audit.targetId === null ||
        !['AI', 'ADMIN'].includes(audit.actorType as string))) ||
    (service === 'consultation' &&
      audit.action !== 'CALL_STARTED' &&
      payload.result === 'SUCCESS' &&
      (audit.actorType !==
        (['CALL_DELETED', 'UNANSWERED_QUESTION_DELETED', 'UNANSWERED_QUESTION_REGISTERED'].includes(
          audit.action as string,
        )
          ? 'ADMIN'
          : 'AI') ||
        audit.targetId === null)) ||
    (service === 'order' &&
      ((billingInitialization
        ? payload.result !== 'SUCCESS' ||
          audit.actorType !== 'SYSTEM' ||
          audit.actorId !== null ||
          audit.actorName !== undefined ||
          !object(audit.metadata) ||
          Object.keys(audit.metadata).sort().join(',') !==
            'amountAfter,amountBefore,billingMonth,paymentMethodType' ||
          typeof audit.metadata.billingMonth !== 'string' ||
          !/^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])$/.test(audit.metadata.billingMonth) ||
          !['credit', 'groupBilling'].includes(audit.metadata.paymentMethodType as string) ||
          !Number.isSafeInteger(audit.metadata.amountBefore) ||
          Number(audit.metadata.amountBefore) < 0 ||
          audit.metadata.amountAfter !== 0
        : paymentCompleted
          ? payload.result !== 'SUCCESS' ||
            audit.actorType !== 'SYSTEM' ||
            !object(audit.metadata) ||
            Object.keys(audit.metadata).join(',') !== 'amountAfter' ||
            !integer(audit.metadata.amountAfter)
          : audit.action === 'ORDER_AMOUNT_CHANGED'
            ? payload.result !== 'SUCCESS' ||
              !object(audit.metadata) ||
              Object.keys(audit.metadata).sort().join(',') !==
                'amountAfter,amountBefore,orderParcelSeqs' ||
              ![audit.metadata.amountBefore, audit.metadata.amountAfter].every(
                (value) =>
                  value === null ||
                  (Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 2147483647),
              ) ||
              !Array.isArray(audit.metadata.orderParcelSeqs) ||
              audit.metadata.orderParcelSeqs.length < 1 ||
              !audit.metadata.orderParcelSeqs.every(integer) ||
              new Set(audit.metadata.orderParcelSeqs).size !== audit.metadata.orderParcelSeqs.length
            : audit.metadata !== undefined) ||
        (payload.result === 'SUCCESS' &&
          (!(billingInitialization || paymentCompleted
            ? audit.actorType === 'SYSTEM'
            : submission
              ? audit.actorType === 'SYSTEM' ||
                (audit.actorType === 'ADMIN' &&
                  ['ORDER_SUBMISSION_STARTED', 'ORDER_RESUBMISSION_STARTED'].includes(
                    audit.action as string,
                  ))
              : [
                    'ORDER_DELETED',
                    'PARCEL_DRAFT_DELETED',
                    'ORDER_PAYMENT_NOTIFICATION_RETRIED',
                    'ORDER_PAYMENT_COMPLETION_NOTIFICATION_RETRIED',
                  ].includes(audit.action as string)
                ? audit.actorType === 'ADMIN'
                : ['ADMIN', 'AI'].includes(audit.actorType as string)) ||
            audit.targetId === null)))) ||
    typeof payload.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(payload.occurredAt))
  )
    throw invalid();
  return {
    audit: audit as unknown as AuditEvent,
    result: payload.result as AuditResult,
    at: payload.occurredAt,
    transactionId: transaction(payload),
    personaVersionSeq: personaReference ? (payload.personaVersionSeq as number) : undefined,
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
export class ServiceAuditReceiver implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly logger = new Logger(ServiceAuditReceiver.name);
  readonly receive: ReturnType<typeof createReceiver>;
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    repository: AuditRepository,
  ) {
    const sources: Record<string, string> = {};
    const handlers: Record<string, (client: PoolClient, event: Event) => Promise<void>> = {};
    for (const service of ['customer', 'consultation', 'order'] as const) {
      const table = `${service}_audit_preparations`;
      const token = config.get(
        service === 'consultation' ? 'CONSULTATION_AUTH_TOKEN' : 'CUSTOMER_AUTH_TOKEN',
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
          if (input.personaVersionSeq !== undefined) {
            const version = await client.query(
              'SELECT 1 FROM ai_persona_versions WHERE ai_persona_version_seq=$1 FOR KEY SHARE',
              [input.personaVersionSeq],
            );
            if (!version.rowCount)
              throw new ApiException(
                404,
                'NOT_FOUND',
                '실제 사용한 페르소나 버전을 찾을 수 없습니다.',
              );
            const reference = await client.query(
              `UPDATE consultation_persona_references SET prepared_event_id=$1
               WHERE transaction_id=$2 AND call_session_seq=$3 AND ai_persona_version_seq=$4 AND NOT committed RETURNING prepared_event_id`,
              [event.eventId, input.transactionId, input.audit.targetId, input.personaVersionSeq],
            );
            if (reference.rowCount !== 1) throw invalid();
          }
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
          const prepared = await client.query<{ event_id: string; audit: unknown }>(
            `SELECT event_id,audit FROM ${table} WHERE event_id=ANY($1::uuid[]) AND transaction_id=$2 AND NOT aborted
             ORDER BY array_position($1::uuid[],event_id) FOR UPDATE`,
            [ids, transactionId],
          );
          if (prepared.rowCount !== ids.length) throw invalid();
          for (const row of prepared.rows)
            if (service === 'consultation' && isFaqExamplesPreparation(row.audit))
              await commitFaqExamples(client, row.audit, transactionId);
            else if (service === 'consultation' && isFaqConversionPreparation(row.audit))
              await commitFaqConversion(client, row.audit, transactionId);
          await client.query(
            `INSERT INTO audit_logs OVERRIDING SYSTEM VALUE
          SELECT (jsonb_populate_record(NULL::audit_logs,p.audit)).* FROM unnest($1::uuid[]) WITH ORDINALITY i(id,n)
          JOIN ${table} p ON p.event_id=i.id WHERE p.audit ? 'audit_log_seq' ORDER BY i.n`,
            [ids],
          );
          await client.query(`DELETE FROM ${table} WHERE event_id=ANY($1::uuid[])`, [ids]);
          if (service === 'consultation')
            await client.query(
              'UPDATE consultation_persona_references SET committed=true WHERE prepared_event_id=ANY($1::uuid[]) AND transaction_id=$2',
              [ids, transactionId],
            );
        },
        [service + ':AuditAborted']: async (client: PoolClient, event: Event) => {
          if (Object.keys(event.payload).join(',') !== 'transactionId') throw invalid();
          const transactionId = transaction(event.payload);
          await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [
            transactionId,
          ]);
          if (service === 'consultation')
            await client.query(
              'DELETE FROM consultation_persona_references WHERE transaction_id=$1 AND NOT committed',
              [transactionId],
            );
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
    handlers['consultation:FaqConversionCommitted'] = handlers['consultation:AuditCommitted'];
    handlers['consultation:FaqQuestionExamplesChunkPrepared'] = async (client, event) => {
      try {
        validateFaqExamples(event.payload);
      } catch {
        throw invalid();
      }
      const transactionId = transaction(event.payload);
      await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [transactionId]);
      const terminal = await client.query<{ aborted: boolean }>(
        'SELECT aborted FROM consultation_audit_preparations WHERE event_id=$1',
        [transactionId],
      );
      if (terminal.rows[0]?.aborted) return;
      await client.query(
        'INSERT INTO consultation_audit_preparations(event_id,transaction_id,audit) VALUES($1,$2,$3)',
        [event.eventId, transactionId, { _faqExamplesChunk: event.payload }],
      );
    };
    handlers['consultation:FaqQuestionExamplesPrepared'] = async (client, event) => {
      let input: FaqExamplesPayload | undefined;
      let chunkIds: string[] = [];
      try {
        if (Object.hasOwn(event.payload, 'chunkEventIds')) {
          validateFaqChunks(event.payload);
          chunkIds = event.payload.chunkEventIds;
        } else {
          validateFaqExamples(event.payload);
          input = event.payload;
        }
      } catch {
        throw invalid();
      }
      const transactionId = transaction(event.payload);
      await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [transactionId]);
      const terminal = await client.query<{ aborted: boolean }>(
        'SELECT aborted FROM consultation_audit_preparations WHERE event_id=$1',
        [transactionId],
      );
      if (terminal.rows[0]?.aborted) return;
      if (chunkIds.length) {
        const chunks = await client.query<{ audit: unknown }>(
          `SELECT audit FROM consultation_audit_preparations
           WHERE event_id=ANY($1::uuid[]) AND transaction_id=$2 AND NOT aborted
           ORDER BY array_position($1::uuid[],event_id) FOR UPDATE`,
          [chunkIds, transactionId],
        );
        if (chunks.rowCount !== chunkIds.length) throw invalid();
        try {
          input = assembleFaqExamples(
            chunks.rows.map((row) => {
              if (!object(row.audit)) throw invalid();
              validateFaqExamples(row.audit._faqExamplesChunk);
              return row.audit._faqExamplesChunk;
            }),
            transactionId,
          );
        } catch {
          throw invalid();
        }
      }
      const prepared = await prepareFaqExamples(client, input!);
      await client.query(
        'INSERT INTO consultation_audit_preparations(event_id,transaction_id,audit) VALUES($1,$2,$3)',
        [event.eventId, transactionId, prepared],
      );
      if (chunkIds.length)
        await client.query(
          'DELETE FROM consultation_audit_preparations WHERE event_id=ANY($1::uuid[])',
          [chunkIds],
        );
    };
    handlers['consultation:FaqConversionPrepared'] = async (client, event) => {
      try {
        validateFaqConversionEvent(event);
      } catch {
        throw invalid();
      }
      const transactionId = transaction(event.payload);
      await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [transactionId]);
      const terminal = await client.query<{ aborted: boolean }>(
        'SELECT aborted FROM consultation_audit_preparations WHERE event_id=$1',
        [transactionId],
      );
      if (terminal.rows[0]?.aborted) return;
      const prepared = await prepareFaqConversion(client, event.payload, repository);
      await client.query(
        'INSERT INTO consultation_audit_preparations(event_id,transaction_id,audit) VALUES($1,$2,$3)',
        [event.eventId, transactionId, prepared],
      );
    };
    this.receive = createReceiver<PoolClient>({ pool: database.pool, sources, handlers });
  }

  async prepareConversion(input: unknown, authorization: string) {
    try {
      validateFaqConversionEvent(input);
    } catch {
      throw invalid();
    }
    await this.receive(input, authorization);
    const prepared = (
      await this.database.pool.query<{ audit: unknown }>(
        'SELECT audit FROM consultation_audit_preparations WHERE event_id=$1 AND transaction_id=$2 AND NOT aborted',
        [input.eventId, input.payload.transactionId],
      )
    ).rows[0]?.audit;
    if (!isFaqConversionPreparation(prepared)) throw new Error('FAQ preparation unavailable');
    return {
      eventId: input.eventId,
      status: 'processed',
      payload: { faqEntrySeq: prepared._faqConversion.faq.faq_entry_seq },
    };
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      if (!this.running)
        this.running = Promise.allSettled([
          this.flushPending(['consultation']),
          this.flushPending(['order']),
        ])
          .then((results) => {
            if (results.some((result) => result.status === 'rejected'))
              this.logger.error({ event: 'service_audit_recovery_unavailable' });
          })
          .finally(() => {
            this.running = undefined;
          });
    }, 1000);
    this.timer.unref();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }

  async flushPending(
    services: readonly ('customer' | 'consultation' | 'order')[] = [
      'customer',
      'consultation',
      'order',
    ],
  ): Promise<void> {
    for (const service of services) {
      const table = `${service}_audit_preparations`;
      const { rows } = await this.database.pool.query<{ transaction_id: string }>(
        `SELECT DISTINCT transaction_id FROM (SELECT transaction_id FROM ${table} WHERE NOT aborted
         ${service === 'consultation' ? 'UNION SELECT transaction_id FROM consultation_persona_references WHERE NOT committed' : ''}
         ) pending ORDER BY transaction_id LIMIT 128`,
      );
      if (!rows.length) continue;
      const url = this.config.get(
        service === 'order'
          ? 'ORDER_URL'
          : service === 'customer'
            ? 'CUSTOMER_URL'
            : 'CONSULTATION_URL',
        {
          infer: true,
        },
      );
      const token = this.config.get(
        service === 'consultation' ? 'CONSULTATION_AUTH_TOKEN' : 'CUSTOMER_AUTH_TOKEN',
        { infer: true },
      );
      if (!url || !token) throw new Error('Service audit confirmation unavailable');
      await sendEvent(url + '/internal/audit/flush', token, {
        eventId: randomUUID(),
        source: 'operations',
        eventType: 'AuditFlushRequested',
        payload: { transactionIds: rows.map((row) => row.transaction_id) },
      });
    }
  }
}
