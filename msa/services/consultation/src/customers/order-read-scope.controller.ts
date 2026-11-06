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
} from '@dva/events/order-read.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/order-read')
export class OrderReadScopeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post()
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
    try {
      return await this.database.transaction(async (client) => {
        const command = event.payload.command;
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
            command.operation === 'OrderDetailRead' &&
            caller.orderSeq === command.id
          )
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '종료된 통화는 기존 연결 주문만 사용할 수 있습니다.',
          );
        const payload = await requestOrderRead(
          this.config.get('CUSTOMER_URL', { infer: true }) +
            '/internal/order-read/call',
          this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
          {
            ...event,
            source: 'consultation',
            payload: {
              command,
              caller: {
                ...caller,
                endedAt: caller.endedAt?.toISOString() ?? null,
              },
            },
          },
        );
        return { eventId: event.eventId, status: 'processed', payload };
      });
    } catch (error) {
      if (error instanceof ApiException) throw error;
      if (error instanceof OrderReadError)
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
