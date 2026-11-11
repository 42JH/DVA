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
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { validateEvent } from '@dva/events';
import {
  requestDraftWrite,
  requestWriteReference,
  validateDraftWrite,
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

type DraftCallSnapshot = Pick<
  DraftWriteCall,
  'callSessionSeq' | 'customerSeq' | 'intakeVersion'
>;

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/parcel-draft-write')
export class ParcelDraftWriteController {
  private readonly activeCalls = new Map<string, number | null>();

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
    private readonly scopes: OrderReferenceScopes,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(@Body() event: unknown) {
    try {
      validateDraftWrite(event, 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_WRITE' }, 422);
    }
    try {
      return await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        const id = event.payload.command.callSessionSeq;
        let call: DraftCallSnapshot | null = null;
        if (id !== null) {
          call =
            (
              await client.query<DraftCallSnapshot>(
                `SELECT call_session_seq AS "callSessionSeq",customer_seq AS "customerSeq",order_intake_version AS "intakeVersion"
               FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
               AND incoming_at>statement_timestamp()-interval '5 years' FOR UPDATE`,
                [id],
              )
            ).rows[0] ?? null;
          if (!call)
            throw new ApiException(
              404,
              'NOT_FOUND',
              '통화를 찾을 수 없습니다.',
            );
          const pending = await requestWriteReference<CallWriteReceipt[]>(
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
              call.intakeVersion = receipt.payload.afterVersion;
              call.customerSeq =
                receipt.payload.customerSeq ?? call.customerSeq;
            }
          }
        }
        return this.scopes.run(event.eventId, client, async () => {
          this.activeCalls.set(event.eventId, id);
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
        !['CallRead', 'CallBumped', 'CallCustomerResolved'].includes(
          event.payload.operation,
        )
      )
        throw new Error('Invalid draft call reference');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_REFERENCE' }, 422);
    }
    const id = event.payload.input.id;
    if (this.activeCalls.get(scopeId) !== id)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    try {
      const payload = await this.scopes.use(scopeId, async (client) => {
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
  ): Promise<DraftWriteCall | null> {
    return (
      (
        await client.query<DraftWriteCall>(
          `SELECT call_session_seq AS "callSessionSeq",caller_phone_number AS "callerPhoneNumber",
         customer_seq AS "customerSeq",to_jsonb(ended_at)#>>'{}' AS "endedAt",order_seq AS "orderSeq",
         order_intake_enabled AS enabled,order_intake_version AS "intakeVersion",
         to_jsonb(order_completion_received_at)#>>'{}' AS "completionReceivedAt" FROM call_sessions WHERE call_session_seq=$1` +
            (active
              ? " AND deleted_at IS NULL AND incoming_at>statement_timestamp()-interval '5 years'"
              : ''),
          [id],
        )
      ).rows[0] ?? null
    );
  }

  @Post('events')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async receive(@Body() event: unknown) {
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
