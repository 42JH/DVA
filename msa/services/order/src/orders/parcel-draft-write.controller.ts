import { validateEvent } from '@dva/events';
import { ApiException } from '../common/errors/api.exception';
import { finalizationId, type IntakeFinalization } from '@dva/events/order-intake-write.cjs';
import { OrderIntakeWritesService } from './order-intake-writes.service';
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
    private readonly intake: OrderIntakeWritesService,
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
      payload: await (event.payload.command.operation.startsWith('OrderIntake')
        ? this.intake.execute(event)
        : this.drafts.execute(event)),
    };
  }

  @Post('reference')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async references(@Body() event: unknown) {
    try {
      validateWriteReference(event);
      if (
        event.source !== 'consultation' ||
        !['PendingCallWritesRead', 'IntakeFinalizationRead'].includes(event.payload.operation)
      )
        throw new Error('Invalid pending draft write query');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_REFERENCE' }, 422);
    }
    if (event.payload.operation === 'IntakeFinalizationRead') {
      return {
        eventId: event.eventId,
        status: 'processed',
        payload: await this.finalization(Number(event.payload.input.id)),
      };
    }
    const { rows } = await this.database.pool.query<CallWriteReceipt>(
      `SELECT event_id AS "eventId",payload FROM outbox_events WHERE destination='consultation'
       AND event_type='ParcelDraftCallWritten' AND aggregate_seq=$1 AND delivered_at IS NULL ORDER BY outbox_seq`,
      [event.payload.input.id],
    );
    return { eventId: event.eventId, status: 'processed', payload: rows };
  }
  private async finalization(id: number): Promise<IntakeFinalization | null> {
    const row = (
      await this.database.pool.query<{ result: IntakeFinalization | null }>(
        "SELECT payload->'result'->'data'->'finalization' AS result FROM inbox_events WHERE event_id=$1 AND source='customer' AND event_type='ParcelDraftWriteRequested'",
        [finalizationId(id)],
      )
    ).rows[0];
    return row?.result ?? null;
  }
  @Post('submit')
  @HttpCode(200)
  async submit(@Body() event: unknown) {
    try {
      validateEvent(event);
      const p = event.payload;
      if (
        event.source !== 'consultation' ||
        event.eventType !== 'OrderIntakeSubmissionRequested' ||
        Object.keys(p).sort().join(',') !== 'callSessionSeq,orderSeq,requestId' ||
        ![p.callSessionSeq, p.orderSeq].every(
          (value) => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647,
        ) ||
        typeof p.requestId !== 'string' ||
        p.requestId.length < 1 ||
        p.requestId.length > 128
      )
        throw new Error('Invalid intake submission');
    } catch {
      throw new HttpException({ error: 'INVALID_INTAKE_SUBMISSION' }, 422);
    }
    const data = await this.finalization(Number(event.payload.callSessionSeq));
    if (
      !data ||
      data.orderSeq !== event.payload.orderSeq ||
      data.requestId !== event.payload.requestId
    )
      throw new ApiException(409, 'INVALID_STATE', '확정된 통화 주문을 확인해 주세요.');
    await this.intake.submitPaidOrder(data.orderSeq!, data.requestId);
    return { eventId: event.eventId, status: 'processed' };
  }
}
