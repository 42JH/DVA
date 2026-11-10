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
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import {
  validateOrderRead,
  requestOrderRead,
  OrderReadError,
  type OrderReadEvent,
} from '@dva/events/order-read.cjs';
import {
  validateParcelDraftCommand,
  type DraftCallReferences,
} from '@dva/events/parcel-drafts.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal')
export class OrderReadScopeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post('order-draft-call-references')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async draftCalls(@Body() event: unknown) {
    try {
      validateParcelDraftCommand(
        event,
        'DraftCallReferencesRequested',
        'order',
      );
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_CALL_QUERY' }, 422);
    }
    const query = event.payload;
    const payload = await this.database.readOnly(async (client) => {
      const started = 'COALESCE(incoming_at,started_at,registered_at)';
      const completed =
        'ended_at IS NOT NULL AND order_finalized_at IS NOT NULL';
      const calls = (
        await client.query<DraftCallReferences['calls'][number]>(
          `SELECT call_session_seq,to_jsonb(${started})#>>'{}' AS started_at FROM call_sessions WHERE call_session_seq=ANY($1::int[]) ORDER BY call_session_seq`,
          [query.callIds],
        )
      ).rows;
      const customers = (
        await client.query<DraftCallReferences['customers'][number]>(
          `SELECT DISTINCT ON(customer_seq) customer_seq,call_session_seq,to_jsonb(${started})#>>'{}' AS started_at FROM call_sessions
          WHERE customer_seq=ANY($1::int[]) AND ${completed} AND ${started} IS NOT NULL ORDER BY customer_seq,${started} DESC,call_session_seq DESC`,
          [query.customerIds],
        )
      ).rows;
      const phoneFilter = query.phoneHashes.length
        ? "(caller_phone_number=ANY($1::text[]) OR encode(sha256(convert_to(caller_phone_number,'UTF8')),'hex')=ANY($2::text[]))"
        : 'caller_phone_number=ANY($1::text[])';
      const phones = (
        await client.query<DraftCallReferences['phones'][number]>(
          `SELECT DISTINCT ON(caller_phone_number) caller_phone_number,call_session_seq,to_jsonb(${started})#>>'{}' AS started_at FROM call_sessions
          WHERE ${phoneFilter} AND ${completed} AND ${started} IS NOT NULL ORDER BY caller_phone_number,${started} DESC,call_session_seq DESC`,
          query.phoneHashes.length
            ? [query.phones, query.phoneHashes]
            : [query.phones],
        )
      ).rows;
      return { calls, customers, phones };
    });
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
