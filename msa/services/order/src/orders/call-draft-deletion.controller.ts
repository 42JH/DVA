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
import { validateParcelDraftCommand } from '@dva/events/parcel-drafts.cjs';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/call-draft-deletion-check')
export class CallDraftDeletionController {
  constructor(private readonly database: DatabaseService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async check(@Body() event: unknown) {
    try {
      validateParcelDraftCommand(event, 'CallDraftDeletionCheckRequested', 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_DRAFT_DELETION_CHECK' }, 422);
    }
    const { rows } = await this.database.pool.query<{ blocked: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM order_parcel_drafts WHERE call_session_seq=$1 AND deleted_at IS NULL
       AND status IN ('READY','EDITING') AND retention_started_at>statement_timestamp()-interval '5 years') AS blocked`,
      [event.payload.callSessionSeq],
    );
    return { eventId: event.eventId, status: 'processed', payload: rows[0].blocked };
  }
}
