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

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@ApiExcludeController()
@SetMetadata('auth:internal-operations', true)
@Controller('internal/faq-call-sources')
export class FaqCallSourcesController {
  constructor(private readonly database: DatabaseService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() input: unknown) {
    try {
      validateEvent(input);
    } catch {
      throw new HttpException({ error: 'INVALID_FAQ_CALL_QUERY' }, 400);
    }
    const ids = input.payload.eventIds;
    if (
      input.source !== 'operations' ||
      input.eventType !== 'FaqCallSourcesRequested' ||
      Object.keys(input.payload).join(',') !== 'eventIds' ||
      !Array.isArray(ids) ||
      ids.length < 1 ||
      ids.length > 10 ||
      ids.some((id) => typeof id !== 'string' || !uuid.test(id)) ||
      new Set(ids.map((id: string) => id.toLowerCase())).size !== ids.length
    )
      throw new HttpException({ error: 'INVALID_FAQ_CALL_QUERY' }, 422);
    const result = await this.database.pool.query<{
      eventId: string;
      callSessionSeq: number;
    }>(
      `SELECT e.event_id AS "eventId",c.call_session_seq AS "callSessionSeq"
       FROM call_insight_events e JOIN call_sessions c ON c.call_session_seq=e.call_session_seq
       WHERE e.event_id=ANY($1::uuid[]) AND c.deleted_at IS NULL
         AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')`,
      [ids],
    );
    const calls = new Map(
      result.rows.map((row) => [row.eventId, row.callSessionSeq]),
    );
    return {
      eventId: input.eventId,
      status: 'processed',
      payload: {
        calls: ids.map((id: string) => ({
          eventId: id,
          callSessionSeq: calls.get(id.toLowerCase()) ?? null,
        })),
      },
    };
  }
}
