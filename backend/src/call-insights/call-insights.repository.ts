import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { CreateCallAnalysisDto } from './dto/create-call-analysis.dto';

@Injectable()
export class CallInsightsRepository {
  async findProviderCallId(client: PoolClient, id: number): Promise<string | undefined> {
    const result = await client.query<{ provider_call_id: string }>(
      "SELECT provider_call_id FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR SHARE",
      [id],
    );
    return result.rows[0]?.provider_call_id;
  }

  async personaVersionExists(client: PoolClient, id: number): Promise<boolean> {
    const result = await client.query(
      'SELECT 1 FROM ai_persona_versions WHERE ai_persona_version_seq=$1 FOR KEY SHARE',
      [id],
    );
    return result.rowCount === 1;
  }

  async insert(
    client: PoolClient,
    id: number,
    input: CreateCallAnalysisDto,
    payloadHash: string,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO call_analyses(call_session_seq,ai_persona_version_seq,ai_started_at,ai_ended_at,
       repeat_question_count,has_complaint,complaints,payload_hash,is_new_customer,
       registered_parcel_count,faq_answer_count,order_lookup_count,cancelled_parcel_count,has_handoff_request,has_callback_request)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT(call_session_seq) DO NOTHING RETURNING call_session_seq`,
      [
        id,
        input.aiPersonaVersionSeq,
        input.startedAt,
        input.endedAt,
        input.repeatQuestionCount,
        input.hasComplaint,
        JSON.stringify(input.complaints),
        payloadHash,
        input.isNewCustomer ?? null,
        input.registeredParcelCount ?? null,
        input.faqAnswerCount ?? null,
        input.orderLookupCount ?? null,
        input.cancelledParcelCount ?? null,
        input.hasHandoffRequest ?? null,
        input.hasCallbackRequest ?? null,
      ],
    );
    return result.rowCount === 1;
  }

  async findPayloadHash(client: PoolClient, id: number): Promise<string | undefined> {
    const result = await client.query<{ payload_hash: string }>(
      'SELECT payload_hash FROM call_analyses WHERE call_session_seq=$1',
      [id],
    );
    return result.rows[0]?.payload_hash;
  }
}
