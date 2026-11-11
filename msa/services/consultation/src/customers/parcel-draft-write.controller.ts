import { OrderIntakeService } from '../consultations/order-intake.service';
import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { ParcelDraftWriteService } from './parcel-draft-write.service';
import { AuditService } from '../audit/audit.service';
import { applyIntakeFinalization } from './order-intake-finalization';
import type { IntakeFinalization } from '@dva/events/order-intake-write.cjs';
import type { PoolClient } from 'pg';
import { validateEvent } from '@dva/events';
import {
  requestWriteReference,
  validateWriteReference,
  validateCallMutation,
  type CallWriteReceipt,
  type DraftWriteCall,
} from '@dva/events/parcel-draft-write.cjs';
import { OrderReadError } from '@dva/events/order-read.cjs';
import { validateReadScope } from '@dva/events/read-scope.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { OrderReferenceScopes } from './order-reference-scopes.service';
import { applyDraftCallWrite } from './parcel-draft-call-write';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/parcel-draft-write')
export class ParcelDraftWriteController {
  constructor(
    private readonly intake: OrderIntakeService,
    private readonly executor: ParcelDraftWriteService,
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly scopes: OrderReferenceScopes,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  execute(@Body() event: unknown) {
    return this.executor.execute(event);
  }

  @Post('reference')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async reference(
    @Body() event: unknown,
    @Headers('x-msa-read-scope') scopeId: string,
  ) {
    try {
      validateWriteReference(event);
      validateReadScope(scopeId);
      if (
        event.source !== 'order' ||
        ![
          'CallRead',
          'CallBumped',
          'CallCustomerResolved',
          'IntakeCallRead',
          'IntakeCallSealed',
        ].includes(event.payload.operation)
      )
        throw new Error('Invalid draft call reference');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_REFERENCE' }, 422);
    }
    const id = event.payload.input.id;
    if (this.executor.activeCalls.get(scopeId)?.id !== id)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    try {
      const payload = await this.scopes.use(scopeId, async (client) => {
        if (
          event.payload.operation === 'IntakeCallRead' ||
          event.payload.operation === 'IntakeCallSealed'
        ) {
          if (event.payload.operation === 'IntakeCallSealed') {
            await client.query(
              'UPDATE call_sessions SET order_completion_received_at=clock_timestamp(),order_completion_payload=$2::jsonb WHERE call_session_seq=$1',
              [id, JSON.stringify(event.payload.input.payload)],
            );
            await this.audit.recordSuccess(
              {
                actorId: null,
                actorType: 'AI',
                targetId: Number(id),
                targetType: 'CALL_SESSION',
                action: 'ORDER_INTAKE_COMPLETED',
                requestId: this.executor.activeCalls.get(scopeId)!.requestId,
              },
              client,
            );
          }
          return this.call(client, id, true, true);
        }
        if (event.payload.operation === 'CallBumped')
          return (
            await client.query<{ version: number }>(
              'UPDATE call_sessions SET order_intake_version=order_intake_version+1 WHERE call_session_seq=$1 RETURNING order_intake_version AS version',
              [id],
            )
          ).rows[0].version;
        if (event.payload.operation === 'CallCustomerResolved')
          await client.query(
            'UPDATE call_sessions SET customer_seq=$2 WHERE call_session_seq=$1 AND customer_seq IS NULL',
            [id, event.payload.input.customerSeq],
          );
        return this.call(client, id, event.payload.operation === 'CallRead');
      });
      return { eventId: event.eventId, status: 'processed', payload };
    } catch (error) {
      this.failure(error);
    }
  }

  private async call(
    client: PoolClient,
    id: unknown,
    active: boolean,
    intake = false,
  ): Promise<DraftWriteCall | null> {
    return (
      (
        await client.query<DraftWriteCall>(
          `SELECT call_session_seq AS "callSessionSeq",caller_phone_number AS "callerPhoneNumber",
         customer_seq AS "customerSeq",to_jsonb(ended_at)#>>'{}' AS "endedAt",order_seq AS "orderSeq",
         order_intake_enabled AS enabled,order_intake_version AS "intakeVersion",
         to_jsonb(order_completion_received_at)#>>'{}' AS "completionReceivedAt"${intake ? `,order_completion_payload AS "completionPayload",to_jsonb(order_finalized_at)#>>'{}' AS "finalizedAt"` : ''} FROM call_sessions WHERE call_session_seq=$1` +
            (active
              ? " AND deleted_at IS NULL AND incoming_at>statement_timestamp()-interval '5 years'"
              : ''),
          [id],
        )
      ).rows[0] ?? null
    );
  }

  @Post('recover')
  @HttpCode(200)
  async recover(@Body() event: unknown) {
    try {
      validateEvent(event);
      if (
        event.source !== 'order' ||
        event.eventType !== 'OrderIntakeRecoveryRequested' ||
        Object.keys(event.payload).length
      )
        throw new Error('Invalid intake recovery');
    } catch {
      throw new HttpException({ error: 'INVALID_INTAKE_RECOVERY' }, 422);
    }
    await this.intake.recoverPending();
    return { eventId: event.eventId, status: 'processed' };
  }
  @Post('events')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async receive(@Body() event: unknown) {
    try {
      validateEvent(event);
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_CALL_WRITE' }, 422);
    }
    if (
      event.source === 'order' &&
      event.eventType === 'OrderIntakeFinalized'
    ) {
      const id = event.payload.callSessionSeq;
      if (
        Object.keys(event.payload).join(',') !== 'callSessionSeq' ||
        !Number.isInteger(id) ||
        Number(id) < 1 ||
        Number(id) > 2147483647
      )
        throw new HttpException({ error: 'INVALID_INTAKE_FINALIZATION' }, 422);
      const data = await requestWriteReference<IntakeFinalization | null>(
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
      if (!data || data.eventId !== event.eventId)
        throw new ApiException(
          503,
          'DEPENDENCY_UNAVAILABLE',
          '서비스를 일시적으로 사용할 수 없습니다.',
        );
      const status = await this.database.transaction((client) =>
        applyIntakeFinalization(client, data, this.audit),
      );
      return { eventId: event.eventId, status };
    }
    try {
      validateEvent(event);
      if (
        event.source !== 'order' ||
        event.eventType !== 'ParcelDraftCallWritten'
      )
        throw new Error('Invalid draft call write');
      validateCallMutation(event.payload);
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_CALL_WRITE' }, 422);
    }
    const receipt: CallWriteReceipt = {
      eventId: event.eventId,
      payload: event.payload,
    };
    const status = await this.database.transaction((client) =>
      applyDraftCallWrite(client, receipt),
    );
    return { eventId: event.eventId, status };
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
