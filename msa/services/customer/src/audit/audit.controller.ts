import {
  Body,
  Controller,
  HttpException,
  HttpCode,
  Post,
  Header,
  Headers,
  SetMetadata,
} from '@nestjs/common';
import { validateEvent } from '@dva/events';
import { ApiExcludeController } from '@nestjs/swagger';
import { AuditService } from './audit.service';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const InternalOperationsAudit = () => SetMetadata('auth:internal-operations', true);
@ApiExcludeController()
@InternalOperationsAudit()
@Controller('internal/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}
  @Post('flush')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async flush(@Body() event: unknown, @Headers('x-dva-audit-snapshot') snapshot?: string) {
    try {
      validateEvent(event);
    } catch {
      throw new HttpException({ error: 'INVALID_AUDIT_EVENT' }, 400);
    }
    const ids = event.payload.transactionIds;
    if (
      event.source !== 'operations' ||
      event.eventType !== 'AuditFlushRequested' ||
      Object.keys(event.payload).join(',') !== 'transactionIds' ||
      !Array.isArray(ids) ||
      ids.length > 128 ||
      ids.some((id) => typeof id !== 'string' || !uuid.test(id))
    )
      throw new HttpException({ error: 'INVALID_AUDIT_EVENT' }, 422);
    if (snapshot === '1') await this.audit.flushSnapshot(ids as string[]);
    else {
      await this.audit.reconcile(ids as string[]);
      await this.audit.flush();
    }
    return { eventId: event.eventId, status: 'processed' };
  }
}
