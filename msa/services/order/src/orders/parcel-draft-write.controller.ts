import {
  ORDER_CREATION_LOCK,
  type CustomerPreparationOutcome,
  type CustomerCreationReceipt,
} from '@dva/events/order-customer-write.cjs';
import { AdminParcelDraftsService } from './admin-parcel-drafts.service';
import { Headers } from '@nestjs/common';
import { validateReadScope } from '@dva/events/read-scope.cjs';
import { ParcelDraftWriteScope } from './parcel-draft-write-scope.service';
import type { RecipientReceipt } from '@dva/events/order-recipient-pins.cjs';
import { OrdersService } from './orders.service';
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
  type OwnerCallWriteReceipt,
} from '@dva/events/parcel-draft-write.cjs';
import { DatabaseService } from '../database/database.service';
import { ParcelDraftWritesService } from './parcel-draft-writes.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/parcel-draft-write')
export class ParcelDraftWriteController {
  constructor(
    private readonly orders: OrdersService,
    private readonly intake: OrderIntakeWritesService,
    private readonly database: DatabaseService,
    private readonly drafts: ParcelDraftWritesService,
    private readonly scope: ParcelDraftWriteScope,
    private readonly adminDrafts: AdminParcelDraftsService,
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
      payload: await (event.payload.command.operation === 'OrderCreated'
        ? this.orders.executeCreation(event)
        : event.payload.command.operation === 'AdminParcelDraftSubmitted'
          ? this.adminDrafts.executeSubmit(event)
          : event.payload.command.operation === 'OrderSubmitted'
            ? this.orders.executeSubmission(event)
            : event.payload.command.operation === 'OrderUpdated'
              ? this.orders.executeUpdate(event)
              : event.payload.command.operation.startsWith('OrderIntake')
                ? this.intake.execute(event)
                : this.drafts.execute(event)),
    };
  }

  @Post('reference')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async references(@Body() event: unknown, @Headers('x-msa-read-scope') scopeId?: string) {
    try {
      validateWriteReference(event);
      if (
        !(
          event.source === 'customer'
            ? ['OrderRecipientsRead', 'RecipientReceiptRead', 'CustomerPreparationOutcomeRead']
            : event.source === 'consultation'
              ? ['PendingCallWritesRead', 'IntakeFinalizationRead']
              : []
        ).includes(event.payload.operation)
      )
        throw new Error('Invalid pending draft write query');
    } catch {
      throw new HttpException({ error: 'INVALID_DRAFT_REFERENCE' }, 422);
    }
    if (event.payload.operation === 'CustomerPreparationOutcomeRead')
      return {
        eventId: event.eventId,
        status: 'processed',
        payload: await this.customerOutcome(String(event.payload.input.writeEventId)),
      };
    if (event.payload.operation === 'OrderRecipientsRead') {
      try {
        validateReadScope(scopeId);
      } catch {
        throw new HttpException({ error: 'INVALID_DRAFT_REFERENCE' }, 422);
      }
      return {
        eventId: event.eventId,
        status: 'processed',
        payload: this.scope.recipients(scopeId, Number(event.payload.input.id)),
      };
    }
    if (event.payload.operation === 'RecipientReceiptRead') {
      const row = (
        await this.database.referencePool.query<{ receipt: RecipientReceipt }>(
          "SELECT i.payload->'result'->'customerReceipt' AS receipt FROM outbox_events o JOIN inbox_events i ON i.event_id=(o.payload->>'writeEventId')::uuid WHERE o.event_id=$1 AND o.destination='customer' AND o.event_type='OrderRecipientPinsWritten' AND i.source='customer' AND i.event_type='ParcelDraftWriteRequested'",
          [event.payload.input.eventId],
        )
      ).rows[0];
      if (!row?.receipt)
        throw new ApiException(404, 'NOT_FOUND', '수령인 PIN 저장 결과를 찾을 수 없습니다.');
      return { eventId: event.eventId, status: 'processed', payload: row.receipt };
    }
    if (event.payload.operation === 'IntakeFinalizationRead') {
      return {
        eventId: event.eventId,
        status: 'processed',
        payload: await this.finalization(Number(event.payload.input.id)),
      };
    }
    // A held owner write can need these reads before releasing a business connection.
    const { rows } = await this.database.referencePool.query<OwnerCallWriteReceipt>(
      `SELECT event_id AS "eventId",payload FROM outbox_events WHERE destination='consultation'
       AND event_type IN ('ParcelDraftCallWritten','OrderCallLinked','LegacyOrderCallWritten') AND aggregate_seq=$1 AND delivered_at IS NULL ORDER BY outbox_seq`,
      [event.payload.input.id],
    );
    return { eventId: event.eventId, status: 'processed', payload: rows };
  }
  private customerOutcome(writeEventId: string): Promise<CustomerPreparationOutcome> {
    return this.database.transaction(async (client) => {
      const locked = (
        await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1,hashtext($2)) AS locked',
          [ORDER_CREATION_LOCK, writeEventId],
        )
      ).rows[0].locked;
      if (!locked) return { status: 'PENDING' };
      const row = (
        await client.query<{
          result: {
            customerCreationReceipt?: CustomerCreationReceipt;
            customerReceipt?: RecipientReceipt | null;
          };
        }>(
          "SELECT payload->'result' AS result FROM inbox_events WHERE event_id=$1 AND source='customer' AND event_type='ParcelDraftWriteRequested'",
          [writeEventId],
        )
      ).rows[0];
      if (!row?.result?.customerCreationReceipt) return { status: 'ABORTED' };
      return {
        status: 'COMMITTED',
        customerCreationReceipt: row.result.customerCreationReceipt,
        recipientReceipt: row.result.customerReceipt ?? null,
      };
    }, this.database.referencePool);
  }

  private async finalization(id: number): Promise<IntakeFinalization | null> {
    const row = (
      await this.database.referencePool.query<{ result: IntakeFinalization | null }>(
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
