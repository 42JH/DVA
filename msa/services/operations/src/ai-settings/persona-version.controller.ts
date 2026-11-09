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
import { validateEvent } from '@dva/events';
import { DatabaseService } from '../database/database.service';
const integer = (value: unknown) =>
  Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiExcludeController()
@SetMetadata('auth:internal-consultation', true)
@Controller('internal/persona-version')
export class PersonaVersionController {
  constructor(private readonly database: DatabaseService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() input: unknown) {
    try {
      validateEvent(input);
    } catch {
      throw new HttpException({ error: 'INVALID_PERSONA_QUERY' }, 400);
    }
    if (
      input.source !== 'consultation' ||
      input.eventType !== 'PersonaVersionRequested' ||
      Object.keys(input.payload).sort().join(',') !== 'callSessionSeq,transactionId,versionSeq' ||
      !integer(input.payload.versionSeq) ||
      !integer(input.payload.callSessionSeq) ||
      typeof input.payload.transactionId !== 'string' ||
      !uuid.test(input.payload.transactionId)
    )
      throw new HttpException({ error: 'INVALID_PERSONA_QUERY' }, 422);
    const exists = await this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(20261105,hashtext($1))', [
        input.payload.transactionId,
      ]);
      const aborted = await client.query(
        'SELECT 1 FROM consultation_audit_preparations WHERE event_id=$1 AND aborted',
        [input.payload.transactionId],
      );
      if (aborted.rowCount) throw new HttpException({ error: 'PERSONA_TRANSACTION_ABORTED' }, 409);
      const version = await client.query(
        'SELECT 1 FROM ai_persona_versions WHERE ai_persona_version_seq=$1 FOR KEY SHARE',
        [input.payload.versionSeq],
      );
      if (!version.rowCount) return false;
      // Preserve source key-share protection from lookup ACK through commit or crash recovery.
      const reserved = await client.query(
        `INSERT INTO consultation_persona_references(prepared_event_id,transaction_id,call_session_seq,ai_persona_version_seq)
        VALUES($1,$2,$3,$4) ON CONFLICT(prepared_event_id) DO UPDATE SET prepared_event_id=EXCLUDED.prepared_event_id
        WHERE consultation_persona_references.transaction_id=EXCLUDED.transaction_id AND consultation_persona_references.call_session_seq=EXCLUDED.call_session_seq
          AND consultation_persona_references.ai_persona_version_seq=EXCLUDED.ai_persona_version_seq AND NOT consultation_persona_references.committed RETURNING prepared_event_id`,
        [
          input.eventId,
          input.payload.transactionId,
          input.payload.callSessionSeq,
          input.payload.versionSeq,
        ],
      );
      if (!reserved.rowCount) throw new HttpException({ error: 'PERSONA_REFERENCE_CONFLICT' }, 409);
      return true;
    });
    return {
      eventId: input.eventId,
      status: 'processed',
      payload: { exists },
    };
  }
}
