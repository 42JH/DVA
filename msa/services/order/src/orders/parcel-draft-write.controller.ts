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
import {
  validateDraftWrite,
  validateWriteReference,
  type CallWriteReceipt,
} from '@dva/events/parcel-draft-write.cjs';
import { DatabaseService } from '../database/database.service';
import { ParcelDraftWritesService } from './parcel-draft-writes.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/parcel-draft-write')
export class ParcelDraftWriteController {
  constructor(
    private readonly database: DatabaseService,
    private readonly drafts: ParcelDraftWritesService,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(@Body() event: unknown) {
    try {
      validateDraftWrite(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_WRITE' }, 422);
    }
    return {
      eventId: event.eventId,
      status: 'processed',
      payload: await this.drafts.execute(event),
    };
  }

  @Post('reference')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async references(@Body() event: unknown) {
    try {
      validateWriteReference(event);
      if (event.source !== 'consultation' || event.payload.operation !== 'PendingCallWritesRead')
        throw new Error('Invalid pending draft write query');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_REFERENCE' }, 422);
    }
    const { rows } = await this.database.pool.query<CallWriteReceipt>(
      `SELECT event_id AS "eventId",payload FROM outbox_events WHERE destination='consultation'
       AND event_type='ParcelDraftCallWritten' AND aggregate_seq=$1 AND delivered_at IS NULL ORDER BY outbox_seq`,
      [event.payload.input.id],
    );
    return { eventId: event.eventId, status: 'processed', payload: rows };
  }
}
