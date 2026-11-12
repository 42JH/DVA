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
import { sendEvent } from '@dva/events';
import { readCallbackUrl } from '@dva/events/read-scope.cjs';
import {
  validateCardCallScope,
  validateCardCaller,
} from '@dva/events/card-call-scope.cjs';
import { DatabaseService } from '../database/database.service';
import { ConsultationsService } from '../consultations/consultations.service';
import { ApiException } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { OrderReferenceScopes } from './order-reference-scopes.service';

@ApiExcludeController()
@Controller('internal/card-call-scope')
@SetMetadata('auth:internal-customer', true)
export class CardCallScopeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly scopes: OrderReferenceScopes,
    private readonly calls: ConsultationsService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(@Body() event: unknown) {
    try {
      validateCardCallScope(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_CARD_CALL_SCOPE' }, 422);
    }
    await this.database.transaction(async (client) => {
      if (event.payload.registration)
        await client.query("SET LOCAL lock_timeout='2s'");
      await this.scopes.run(event.eventId, client, () =>
        sendEvent(
          readCallbackUrl(
            this.config.get('CUSTOMER_URL', { infer: true }),
            '/internal/card-call-scope/callback',
            event.payload.customerAddress ?? null,
          ),
          this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
          {
            eventId: event.eventId,
            source: 'consultation',
            eventType: 'PaymentCardCallScopeRequested',
            payload: {
              consultationAddress:
                this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
            },
          },
          null,
        ),
      );
    });
    return { eventId: event.eventId, status: 'processed' };
  }

  @Post('caller')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async caller(@Body() event: unknown) {
    try {
      validateCardCaller(event);
    } catch {
      throw new HttpException({ error: 'INVALID_CARD_CALLER' }, 422);
    }
    try {
      const caller = await this.scopes.use(event.payload.scopeId, (client) =>
        this.calls.ongoingCaller(client, event.payload.callSessionSeq),
      );
      return { eventId: event.eventId, status: 'processed', payload: caller };
    } catch (error: unknown) {
      const failure =
        error instanceof ApiException
          ? error
          : new ApiException(
              500,
              'INTERNAL_ERROR',
              '서버 오류가 발생했습니다.',
            );
      throw new HttpException(
        { error: failure.getResponse() },
        failure.getStatus(),
      );
    }
  }
}
