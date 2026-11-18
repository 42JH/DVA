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
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@Controller('internal')
export class OrderReadScopeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post('order-read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @SetMetadata('auth:internal-operations', true)
  async admin(@Body() event: unknown) {
    try {
      validateOrderRead(event, 'order');
      if (event.payload.command.callSessionSeq !== null) throw new Error('Unexpected call');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_READ' }, 422);
    }
    return this.query(event);
  }

  @Post('order-read/call')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @SetMetadata('auth:internal-consultation', true)
  async call(@Body() event: unknown) {
    try {
      validateOrderRead(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_READ' }, 422);
    }
    return this.query(event);
  }

  @Post('order-cancellation/call')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @SetMetadata('auth:internal-consultation', true)
  async cancel(@Body() event: unknown) {
    try {
      validateOrderCancellation(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_ORDER_CANCELLATION' }, 422);
    }
    return this.query(event);
  }

  private async query(event: OrderReadEvent | OrderCancellationEvent) {
    try {
      return await this.database.transaction(async (client) => {
        const command = event.payload.command;
        const customer = (
          await client.query<{ id: number }>(
            command.callSessionSeq === null
              ? 'SELECT customer_seq AS id FROM customers WHERE customer_seq=$1 AND deleted_at IS NULL FOR SHARE'
              : "SELECT customer_seq AS id FROM customers WHERE phone_number=$1 AND status='ACTIVE' AND deleted_at IS NULL FOR SHARE",
            [command.callSessionSeq === null ? command.id : event.payload.caller!.phone],
          )
        ).rows[0];
        if (!customer) {
          if (command.callSessionSeq === null)
            throw new ApiException(404, 'NOT_FOUND', '고객을 찾을 수 없습니다.');
          throw new ApiException(
            403,
            'FORBIDDEN',
            '통화 발신번호에 연결된 활성 고객이 필요합니다.',
          );
        }
        const origin = this.config.get('ORDER_URL', { infer: true });
        if (!origin) throw new Error('Order service unavailable');
        const next = {
          ...event,
          source: 'customer',
          payload: {
            command,
            customerSeq: customer.id,
            ...('unpaidOnly' in event.payload && event.payload.unpaidOnly
              ? { unpaidOnly: true as const }
              : {}),
          },
        };
        const token = this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true });
        const payload =
          event.eventType === 'OrderCancellationRequested'
            ? await requestOrderCancellation(
                origin + '/internal/order-cancellation',
                token,
                next as OrderCancellationEvent,
              )
            : await requestOrderRead(
                origin + '/internal/order-read',
                token,
                next as OrderReadEvent,
              );
        return { eventId: event.eventId, status: 'processed', payload };
      });
    } catch (error) {
      if (error instanceof ApiException) throw error;
      if (error instanceof OrderReadError || error instanceof OrderCancellationError)
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
