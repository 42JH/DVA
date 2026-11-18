import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { Environment } from '../config/environment';
import { AuditService } from '../audit/audit.service';
import type { PoolClient } from 'pg';
import { CreateCallAnalysisDto } from './dto/create-call-analysis.dto';

@Injectable()
export class CallInsightsRepository {
  constructor(
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
  ) {}
  async lockFailureCall(
    client: PoolClient,
    id: number,
  ): Promise<string | undefined> {
    // Lock before checking analysis so the existing success path's FOR SHARE cannot race us.
    const result = await client.query<{ provider_call_id: string }>(
      "SELECT provider_call_id FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR UPDATE",
      [id],
    );
    return result.rows[0]?.provider_call_id;
  }

  async recordFailure(client: PoolClient, id: number): Promise<boolean> {
    const result = await client.query(
      `UPDATE call_sessions c SET analysis_failed_at=clock_timestamp()
       WHERE c.call_session_seq=$1 AND c.analysis_failed_at IS NULL
         AND NOT EXISTS(SELECT 1 FROM call_analyses a WHERE a.call_session_seq=c.call_session_seq)
       RETURNING c.call_session_seq`,
      [id],
    );
    return result.rowCount === 1;
  }

  async findProviderCallId(
    client: PoolClient,
    id: number,
  ): Promise<string | undefined> {
    const result = await client.query<{ provider_call_id: string }>(
      "SELECT provider_call_id FROM call_sessions WHERE call_session_seq=$1 AND deleted_at IS NULL AND (incoming_at IS NULL OR incoming_at>clock_timestamp()-interval '5 years') FOR SHARE",
      [id],
    );
    return result.rows[0]?.provider_call_id;
  }

  async personaVersionExists(
    client: PoolClient,
    id: number,
    callSessionSeq: number,
  ): Promise<boolean> {
    const eventId = randomUUID();
    const transactionId = await this.audit.begin(client);
    const response = await fetch(
      this.config.get('OPERATIONS_URL', { infer: true }) +
        '/internal/persona-version',
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.get('CONSULTATION_AUTH_TOKEN', { infer: true })}`,
        },
        body: JSON.stringify({
          eventId,
          source: 'consultation',
          eventType: 'PersonaVersionRequested',
          payload: { versionSeq: id, callSessionSeq, transactionId },
        }),
      },
    );
    if (
      response.status !== 200 ||
      !/^application\/json(?:\s*;|$)/i.test(
        response.headers.get('content-type') ?? '',
      )
    ) {
      await response.body?.cancel();
      throw new Error('Persona version query unavailable');
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      if (size > 4096) throw new Error('Invalid persona query acknowledgement');
      chunks.push(chunk);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'eventId,payload,status' ||
      !('eventId' in value) ||
      value.eventId !== eventId ||
      !('status' in value) ||
      value.status !== 'processed' ||
      !('payload' in value) ||
      !value.payload ||
      typeof value.payload !== 'object' ||
      Array.isArray(value.payload) ||
      Object.keys(value.payload).join(',') !== 'exists' ||
      !('exists' in value.payload) ||
      typeof value.payload.exists !== 'boolean'
    )
      throw new Error('Invalid persona query acknowledgement');
    return value.payload.exists;
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

  async findPayloadHash(
    client: PoolClient,
    id: number,
  ): Promise<string | undefined> {
    const result = await client.query<{ payload_hash: string }>(
      'SELECT payload_hash FROM call_analyses WHERE call_session_seq=$1',
      [id],
    );
    return result.rows[0]?.payload_hash;
  }
}
