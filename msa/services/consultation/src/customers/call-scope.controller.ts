import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import {
  requestScope,
  ScopeResponseError,
  validateScopeEvent,
} from '@dva/events/call-scope.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import type { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/call-scope')
export class CallScopeController {
  constructor(
    private readonly database: DatabaseService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  @Post()
  @HttpCode(200)
  async execute(@Body() event: unknown) {
    try {
      validateScopeEvent(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_SCOPE_EVENT' }, 422);
    }
    try {
      return await this.database.transaction(async (client) => {
        const caller = (
          await client.query<{
            phone: string | null;
            customerSeq: number | null;
            endedAt: Date | null;
          }>(
            `SELECT caller_phone_number AS phone,customer_seq AS "customerSeq",ended_at AS "endedAt"
           FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL
           AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years')${event.payload.command.operation === 'PersonalPinsListed' ? '' : ' FOR SHARE'}`,
            [event.payload.command.callSessionSeq],
          )
        ).rows[0];
        const payload = await requestScope(
          this.config.get('CUSTOMER_URL', { infer: true }) +
            '/internal/call-scope',
          this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true }),
          {
            ...event,
            source: 'consultation',
            payload: {
              command: event.payload.command,
              caller: caller
                ? { ...caller, endedAt: caller.endedAt?.toISOString() ?? null }
                : null,
            },
          },
        );
        return { eventId: event.eventId, status: 'processed', payload };
      });
    } catch (error) {
      if (error instanceof ScopeResponseError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      if (error instanceof ApiException) throw error;
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }
}
