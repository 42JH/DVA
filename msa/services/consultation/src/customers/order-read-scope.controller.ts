import {
  validateOrderCancellation,
  requestOrderCancellation,
  OrderCancellationError,
  type OrderCancellationEvent,
} from '@dva/events/order-cancellation.cjs';
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
import { PoolClient } from 'pg';
import {
  ReadScopes,
  readCallbackUrl,
  retryReadSnapshot,
  validateReadScope,
} from '@dva/events/read-scope.cjs';
import {
  validateAdminOrderRead,
  requestAdminOrderRead,
} from '@dva/events/order-read.cjs';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import {
  validateOrderRead,
  requestOrderRead,
  requestDraftRead,
  requestDraftDeletion,
  OrderReadError,
  type OrderReadEvent,
} from '@dva/events/order-read.cjs';
import {
  validateParcelDraftCommand,
  type DraftCallReferences,
  validateDraftRead,
  validateDraftDeletion,
  validateDraftReadCallQuery,
  type DraftReadCall,
} from '@dva/events/parcel-drafts.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal')
export class OrderReadScopeController {
  private readonly draftCallIds = new Map<string, number | null>();

  @Post('parcel-draft-delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftDelete(@Body() event: unknown) {
    try {
      validateDraftDeletion(event, 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_DELETION' }, 422);
    }
    try {
      return await this.database.transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        return this.reads.run(event.eventId, client, async () => {
          const url = readCallbackUrl(
            this.config.get('ORDER_URL', { infer: true }),
            '/internal/parcel-draft-delete',
            event.payload.orderAddress ?? null,
          );
          const token = this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true });
          const base = {
            eventId: event.eventId,
            source: 'consultation' as const,
            eventType: 'ParcelDraftDeletionRequested' as const,
            payload: {
              command: event.payload.command,
              consultationAddress:
                this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
            },
          };
          const hint = await requestDraftDeletion(url, token, {
            ...base,
            payload: { ...base.payload, phase: 'hint', callFinalized: null },
          });
          if (hint === true) throw new Error('Invalid draft deletion hint');
          if (hint === null)
            throw new ApiException(
              404,
              'NOT_FOUND',
              '배송 초안을 찾을 수 없습니다.',
            );
          const call =
            hint.callSessionSeq === null
              ? undefined
              : (
                  await client.query<{ finalized: boolean }>(
                    "SELECT order_finalized_at IS NOT NULL AS finalized FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL AND incoming_at>statement_timestamp()-interval '5 years' FOR UPDATE",
                    [hint.callSessionSeq],
                  )
                ).rows[0];
          const payload = await requestDraftDeletion(url, token, {
            ...base,
            payload: {
              ...base.payload,
              phase: 'delete',
              callFinalized: call?.finalized ?? null,
            },
          });
          return { eventId: event.eventId, status: 'processed', payload };
        });
      });
    } catch (error: unknown) {
      if (error instanceof OrderReadError)
        throw new HttpException({ error: error.error }, error.status);
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === '55P03'
      )
        throw new HttpException(
          {
            error: new ApiException(
              409,
              'REQUEST_IN_PROGRESS',
              '다른 작업의 완료 대기 시간을 초과했습니다. 잠시 후 재시도해 주세요.',
            ).getResponse(),
          },
          409,
        );
      if (error instanceof ApiException)
        throw new HttpException(
          { error: error.getResponse() },
          error.getStatus(),
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  @Post('parcel-draft-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftRead(@Body() event: unknown) {
    try {
      validateDraftRead(event, 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_READ' }, 422);
    }
    try {
      return await retryReadSnapshot(() =>
        this.database.transaction(async (client) => {
          const id = event.payload.command.callSessionSeq;
          await client.query(
            'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ' +
              (id === null ? ' READ ONLY' : ''),
          );
          if (id === null) await client.query('SELECT 1');
          else {
            const call = await this.draftCall(client, id, true);
            if (!call)
              throw new ApiException(
                404,
                'NOT_FOUND',
                '통화를 찾을 수 없습니다.',
              );
            if (!call.enabled)
              throw new ApiException(
                409,
                'INVALID_STATE',
                '이전 계약의 통화입니다. 새 통화에서 초안을 접수해 주세요.',
              );
          }
          return this.reads.run(event.eventId, client, async () => {
            this.draftCallIds.set(event.eventId, id);
            try {
              const payload = await requestDraftRead(
                this.config.get('CUSTOMER_URL', { infer: true }) +
                  '/internal/call-read-references/parcel-drafts',
                this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
                {
                  ...event,
                  source: 'consultation',
                  payload: {
                    ...event.payload,
                    consultationAddress:
                      this.config.get('MSA_INSTANCE_IP', { infer: true }) ??
                      null,
                  },
                },
              );
              return { eventId: event.eventId, status: 'processed', payload };
            } finally {
              this.draftCallIds.delete(event.eventId);
            }
          });
        }),
      );
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new HttpException({ error: error.error }, error.status);
      if (error instanceof ApiException)
        throw new HttpException(
          { error: error.getResponse() },
          error.getStatus(),
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  private async draftCall(client: PoolClient, id: number, lock = false) {
    return (
      await client.query<DraftReadCall>(
        `SELECT call_session_seq AS "callSessionSeq",caller_phone_number AS "callerPhoneNumber",customer_seq AS "customerSeq",
       to_jsonb(ended_at)#>>'{}' AS "endedAt",order_intake_enabled AS enabled,order_intake_version AS "intakeVersion"
       FROM call_sessions WHERE call_session_seq=$1` +
          (lock
            ? " AND deleted_at IS NULL AND incoming_at>statement_timestamp()-interval '5 years' FOR SHARE"
            : ''),
        [id],
      )
    ).rows[0];
  }

  @Post('parcel-draft-read/call')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftReadCall(
    @Body() event: unknown,
    @Headers('x-msa-read-scope') scopeId: string,
  ) {
    try {
      validateDraftReadCallQuery(event);
      validateReadScope(scopeId);
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_READ_CALL' }, 422);
    }
    if (this.draftCallIds.get(scopeId) !== event.payload.callSessionSeq)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    const payload = await this.reads.use(scopeId, (client) =>
      this.draftCall(client, event.payload.callSessionSeq),
    );
    if (!payload)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    return { eventId: event.eventId, status: 'processed', payload };
  }

  private readonly reads = new ReadScopes<PoolClient>(
    () =>
      new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      ),
  );

  @Post('admin-order-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async adminOrders(@Body() event: unknown) {
    try {
      validateAdminOrderRead(event, 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_ADMIN_ORDER_READ' }, 422);
    }
    try {
      return await this.database.readOnly(async (client) => {
        await client.query('SELECT 1');
        return this.reads.run(event.eventId, client, async () => {
          const payload = await requestAdminOrderRead(
            this.config.get('CUSTOMER_URL', { infer: true }) +
              '/internal/call-read-references/admin-orders',
            this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
            {
              ...event,
              source: 'consultation',
              payload: {
                ...event.payload,
                consultationAddress:
                  this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
              },
            },
          );
          return { eventId: event.eventId, status: 'processed', payload };
        });
      });
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new HttpException({ error: error.error }, error.status);
      if (error instanceof ApiException) throw error;
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }

  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post('order-draft-call-references')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftCalls(
    @Body() event: unknown,
    @Headers('x-msa-read-scope') scopeId?: string,
  ) {
    try {
      if (scopeId !== undefined) validateReadScope(scopeId);
      validateParcelDraftCommand(
        event,
        'DraftCallReferencesRequested',
        'order',
      );
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_CALL_QUERY' }, 422);
    }
    const query = event.payload;
    const work = async (client: PoolClient) => {
      const started = 'COALESCE(incoming_at,started_at,registered_at)',
        completed = 'ended_at IS NOT NULL AND order_finalized_at IS NOT NULL';
      const phoneFilter = query.phoneHashes.length
        ? "(caller_phone_number=ANY($3::text[]) OR encode(sha256(convert_to(caller_phone_number,'UTF8')),'hex')=ANY($4::text[]))"
        : 'caller_phone_number=ANY($3::text[])';
      return (
        await client.query<{ payload: DraftCallReferences }>(
          `SELECT jsonb_build_object(
          'calls',COALESCE((SELECT jsonb_agg(c ORDER BY call_session_seq) FROM(SELECT call_session_seq,to_jsonb(${started})#>>'{}' AS started_at FROM call_sessions WHERE call_session_seq=ANY($1::int[])) c),'[]'::jsonb),
          'customers',COALESCE((SELECT jsonb_agg(c ORDER BY customer_seq) FROM(SELECT DISTINCT ON(customer_seq) customer_seq,call_session_seq,to_jsonb(${started})#>>'{}' AS started_at FROM call_sessions
            WHERE customer_seq=ANY($2::int[]) AND ${completed} AND ${started} IS NOT NULL ORDER BY customer_seq,${started} DESC,call_session_seq DESC) c),'[]'::jsonb),
          'phones',COALESCE((SELECT jsonb_agg(c ORDER BY caller_phone_number) FROM(SELECT DISTINCT ON(caller_phone_number) caller_phone_number,call_session_seq,to_jsonb(${started})#>>'{}' AS started_at FROM call_sessions
            WHERE ${phoneFilter} AND ${completed} AND ${started} IS NOT NULL ORDER BY caller_phone_number,${started} DESC,call_session_seq DESC) c),'[]'::jsonb)) AS payload`,
          [
            query.callIds,
            query.customerIds,
            query.phones,
            ...(query.phoneHashes.length ? [query.phoneHashes] : []),
          ],
        )
      ).rows[0].payload;
    };
    const payload =
      scopeId === undefined
        ? await this.database.readOnly(work)
        : await this.reads.use(scopeId, work);
    return { eventId: event.eventId, status: 'processed', payload };
  }

  @Post('order-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() event: unknown) {
    try {
      validateOrderRead(event, 'order');
      if (event.payload.command.callSessionSeq === null)
        throw new Error('Missing call');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_READ' }, 422);
    }
    return this.queryScoped(event);
  }

  @Post('order-cancellation')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async cancel(@Body() event: unknown) {
    try {
      validateOrderCancellation(event, 'order');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_CANCELLATION' }, 422);
    }
    return this.queryScoped(event);
  }

  private async queryScoped(event: OrderReadEvent | OrderCancellationEvent) {
    try {
      return await this.database.transaction(async (client) => {
        const command = event.payload.command;
        if (
          event.eventType === 'OrderCancellationRequested' &&
          (
            await client.query(
              'SELECT 1 FROM call_sessions WHERE call_session_seq=$1 AND order_intake_enabled',
              [command.callSessionSeq],
            )
          ).rowCount
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '신규 통화의 수정·취소는 배송 초안 API를 사용해 주세요.',
          );
        const caller = (
          await client.query<{
            phone: string | null;
            endedAt: Date | null;
            orderSeq: number | null;
          }>(
            `SELECT caller_phone_number AS phone,ended_at AS "endedAt",order_seq AS "orderSeq"
           FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
             AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR SHARE`,
            [command.callSessionSeq],
          )
        ).rows[0];
        if (!caller)
          throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
        if (
          caller.endedAt !== null &&
          !(
            (event.eventType === 'OrderCancellationRequested' ||
              ('operation' in command &&
                command.operation === 'OrderDetailRead')) &&
            caller.orderSeq === command.id
          )
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '종료된 통화는 기존 연결 주문만 사용할 수 있습니다.',
          );
        const next = {
          ...event,
          source: 'consultation',
          payload: {
            command,
            caller: {
              ...caller,
              endedAt: caller.endedAt?.toISOString() ?? null,
            },
          },
        };
        const origin = this.config.get('CUSTOMER_URL', { infer: true });
        const token = this.config.get('CONSULTATION_AUTH_TOKEN', {
          infer: true,
        });
        const payload =
          event.eventType === 'OrderCancellationRequested'
            ? await requestOrderCancellation(
                origin + '/internal/order-cancellation/call',
                token,
                next as OrderCancellationEvent,
              )
            : await requestOrderRead(
                origin + '/internal/order-read/call',
                token,
                next as OrderReadEvent,
              );
        return { eventId: event.eventId, status: 'processed', payload };
      });
    } catch (error) {
      if (error instanceof ApiException) throw error;
      if (
        error instanceof OrderReadError ||
        error instanceof OrderCancellationError
      )
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }
}
