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
  validateParcelDraftCommand,
  type LegacyDraftCallBinding,
} from '@dva/events/parcel-drafts.cjs';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/legacy-draft-call-bindings')
export class LegacyDraftCallBindingsController {
  constructor(private readonly database: DatabaseService) {}

  @Post('read')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async read(@Body() event: unknown) {
    try {
      validateParcelDraftCommand(
        event,
        'LegacyDraftCallBindingsReadRequested',
        'order',
      );
    } catch {
      throw new HttpException({ error: 'INVALID_LEGACY_DRAFT_COMMAND' }, 422);
    }
    const rows = await this.database.transaction(async (client) => {
      const state = (
        await client.query<{ pruned: boolean }>(
          'SELECT pruned FROM parcel_draft_call_snapshot_state WHERE singleton FOR SHARE',
        )
      ).rows[0];
      if (!state || state.pruned)
        throw new HttpException({ error: 'LEGACY_DRAFT_SNAPSHOT_CLOSED' }, 409);
      return (
        await client.query<LegacyDraftCallBinding>(
          `SELECT ids.id AS "orderSeq",s.call_session_seq AS "callSessionSeq",s.caller_phone_number AS "callerPhoneNumber"
       FROM unnest($1::integer[]) AS ids(id) LEFT JOIN legacy_parcel_draft_call_snapshots s ON s.legacy_order_seq=ids.id`,
          [event.payload.orderSeqs],
        )
      ).rows;
    });
    return { eventId: event.eventId, status: 'processed', payload: rows };
  }

  @Post('prune')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async prune(@Body() event: unknown) {
    try {
      validateParcelDraftCommand(
        event,
        'LegacyDraftCallBindingsPruneRequested',
        'order',
      );
    } catch {
      throw new HttpException({ error: 'INVALID_LEGACY_DRAFT_COMMAND' }, 422);
    }
    await this.database.transaction(async (client) => {
      const state = await client.query(
        'SELECT 1 FROM parcel_draft_call_snapshot_state WHERE singleton FOR UPDATE',
      );
      if (state.rowCount !== 1)
        throw new Error('Missing parcel draft snapshot state');
      await client.query('DELETE FROM legacy_parcel_draft_call_snapshots');
      await client.query(
        'UPDATE parcel_draft_call_snapshot_state SET pruned=true WHERE singleton',
      );
    });
    return { eventId: event.eventId, status: 'processed', payload: true };
  }
}
