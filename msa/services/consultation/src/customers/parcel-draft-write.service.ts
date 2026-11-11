import { Injectable, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  requestDraftWrite,
  requestWriteReference,
  validateDraftWrite,
  type OwnerCallWriteReceipt,
  type DraftWriteCall,
} from '@dva/events/parcel-draft-write.cjs';
import type { IntakeFinalization } from '@dva/events/order-intake-write.cjs';
import { OrderReadError } from '@dva/events/order-read.cjs';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { OrderReferenceScopes } from './order-reference-scopes.service';
import { applyDraftCallWrite } from './parcel-draft-call-write';
import { applyIntakeFinalization } from './order-intake-finalization';
type DraftCallSnapshot = Pick<
  DraftWriteCall,
  'callSessionSeq' | 'customerSeq' | 'intakeVersion'
>;
@Injectable()
export class ParcelDraftWriteService {
  readonly activeCalls = new Map<
    string,
    { id: number | null; requestId: string; operation: string }
  >();
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
    private readonly scopes: OrderReferenceScopes,
  ) {}

  async execute(event: unknown) {
    try {
      validateDraftWrite(event, 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_WRITE' }, 422);
    }
    try {
      return await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        const id = event.payload.command.callSessionSeq;
        const updatingOrder =
          event.payload.command.operation === 'OrderUpdated';
        if (
          updatingOrder &&
          event.payload.command.adminId === null &&
          id !== null &&
          (
            await client.query(
              'SELECT 1 FROM call_sessions WHERE call_session_seq=$1 AND order_intake_enabled',
              [id],
            )
          ).rowCount
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '신규 통화의 수정·취소는 배송 초안 API를 사용해 주세요.',
          );
        let call: DraftCallSnapshot | null = null;
        if (id !== null) {
          call =
            (
              await client.query<DraftCallSnapshot>(
                `SELECT call_session_seq AS "callSessionSeq",customer_seq AS "customerSeq",order_intake_version AS "intakeVersion"
               FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
               AND ${updatingOrder ? "(incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years')" : "incoming_at>statement_timestamp()-interval '5 years'"} FOR UPDATE`,
                [id],
              )
            ).rows[0] ?? null;
          if (!call)
            throw new ApiException(
              404,
              'NOT_FOUND',
              '통화를 찾을 수 없습니다.',
            );
          const finalized =
            await requestWriteReference<IntakeFinalization | null>(
              this.config.get('ORDER_URL', { infer: true }) +
                '/internal/parcel-draft-write/reference',
              this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
              {
                eventId: randomUUID(),
                source: 'consultation',
                eventType: 'ParcelDraftWriteReferenceRequested',
                payload: { operation: 'IntakeFinalizationRead', input: { id } },
              },
            );
          if (finalized)
            await applyIntakeFinalization(client, finalized, this.audit);
          const pending = await requestWriteReference<OwnerCallWriteReceipt[]>(
            this.config.get('ORDER_URL', { infer: true }) +
              '/internal/parcel-draft-write/reference',
            this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
            {
              eventId: randomUUID(),
              source: 'consultation',
              eventType: 'ParcelDraftWriteReferenceRequested',
              payload: { operation: 'PendingCallWritesRead', input: { id } },
            },
          );
          for (const receipt of pending) {
            if ((await applyDraftCallWrite(client, receipt)) === 'processed') {
              if ('afterVersion' in receipt.payload)
                call.intakeVersion = receipt.payload.afterVersion;
              call.customerSeq =
                receipt.payload.customerSeq ?? call.customerSeq;
            }
          }
        }
        return this.scopes.run(event.eventId, client, async () => {
          this.activeCalls.set(event.eventId, {
            id,
            requestId: event.payload.command.requestId,
            operation: event.payload.command.operation,
          });
          try {
            const payload = await requestDraftWrite(
              this.config.get('CUSTOMER_URL', { infer: true }) +
                '/internal/call-read-references/parcel-draft-write',
              this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
              {
                ...event,
                source: 'consultation',
                payload: {
                  ...event.payload,
                  call,
                  consultationAddress:
                    this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
                },
              },
            );
            const finalized = payload.data.finalization;
            if (finalized)
              await applyIntakeFinalization(
                client,
                finalized as IntakeFinalization,
                this.audit,
              );
            if (payload.receipt)
              await applyDraftCallWrite(client, payload.receipt, true);
            return { eventId: event.eventId, status: 'processed', payload };
          } finally {
            this.activeCalls.delete(event.eventId);
          }
        });
      });
    } catch (error) {
      this.failure(error);
    }
  }

  private failure(error: unknown): never {
    if (error instanceof ApiException) throw error;
    if (error instanceof OrderReadError)
      throw new ApiException(
        error.status,
        error.error.code as ErrorCode,
        error.error.message,
        error.error.details,
      );
    if (error instanceof Error && 'code' in error) {
      if (error.code === '55P03')
        throw new ApiException(
          409,
          'REQUEST_IN_PROGRESS',
          '다른 작업의 완료 대기 시간을 초과했습니다. 잠시 후 재시도해 주세요.',
        );
      throw error;
    }
    throw new ApiException(
      503,
      'DEPENDENCY_UNAVAILABLE',
      '서비스를 일시적으로 사용할 수 없습니다.',
    );
  }
}
