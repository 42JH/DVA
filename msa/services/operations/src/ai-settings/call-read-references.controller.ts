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
  validateReferenceQuery,
  validatePersonaComparisonQuery,
  validateComplaintFaqQuery,
  type ReferenceRows,
  type PersonaComparisonRow,
  type ComplaintFaqRow,
} from '@dva/events/call-read-references.cjs';
import { DatabaseService } from '../database/database.service';

@ApiExcludeController()
@SetMetadata('auth:internal-consultation', true)
@Controller('internal/call-read-references')
export class CallReadReferencesController {
  constructor(private readonly database: DatabaseService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async query(@Body() input: unknown) {
    try {
      validateReferenceQuery(input);
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_REFERENCE_QUERY' }, 422);
    }
    const result = await this.database.pool.query<ReferenceRows['persona']>(
      `SELECT ai_persona_version_seq,name,version FROM ai_persona_versions
       WHERE ai_persona_version_seq=ANY($1::int[]) ORDER BY ai_persona_version_seq`,
      [input.payload.ids],
    );
    return { eventId: input.eventId, status: 'processed', payload: result.rows };
  }

  @Post('faqs')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async faqs(@Body() input: unknown) {
    try {
      validateReferenceQuery(input);
    } catch {
      throw new HttpException({ error: 'INVALID_CALL_REFERENCE_QUERY' }, 422);
    }
    const result = await this.database.pool.query<ReferenceRows['faq']>(
      `SELECT faq_entry_seq FROM faq_entries WHERE faq_entry_seq=ANY($1::int[])
       AND deleted_at IS NULL ORDER BY faq_entry_seq`,
      [input.payload.ids],
    );
    return { eventId: input.eventId, status: 'processed', payload: result.rows };
  }

  @Post('persona-comparison')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async comparison(@Body() input: unknown) {
    try {
      validatePersonaComparisonQuery(input);
    } catch {
      throw new HttpException({ error: 'INVALID_PERSONA_COMPARISON_QUERY' }, 422);
    }
    const result = await this.database.pool.query<PersonaComparisonRow>(
      `SELECT ai_persona_seq,ai_persona_version_seq,name,version,status,previous_active_version_seq
       FROM ai_persona_versions WHERE status='ACTIVE' OR ai_persona_version_seq IN (
         SELECT previous_active_version_seq FROM ai_persona_versions WHERE status='ACTIVE'
       ) ORDER BY ai_persona_version_seq`,
    );
    return { eventId: input.eventId, status: 'processed', payload: result.rows };
  }

  @Post('complaint-faqs')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async complaintFaqs(@Body() input: unknown) {
    try {
      validateComplaintFaqQuery(input);
    } catch {
      throw new HttpException({ error: 'INVALID_COMPLAINT_FAQ_QUERY' }, 422);
    }
    const result = await this.database.pool.query<ComplaintFaqRow>(
      'SELECT question,answer FROM faq_entries WHERE deleted_at IS NULL ORDER BY faq_entry_seq',
    );
    return { eventId: input.eventId, status: 'processed', payload: result.rows };
  }
}
