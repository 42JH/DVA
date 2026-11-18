import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../audit/audit.service';
import { randomUUID } from 'node:crypto';
import type { CallEvent } from './complaint-judge';
import { ComplaintFaqClient } from './complaint-faq.client';

export const MAX_TRIES = 3; // 모델 장애로 3번 실패하면 더 집지 않음 (has_complaint는 NULL = 미판정으로 남음)
const GIVE_UP = 10; // 판정할 수 없는 통화(대본이 너무 김) — 다시 집지 않음
const LEASE = "interval '10 minutes'"; // 한 통화 판정은 길어야 3분 남짓. 그 사이 다른 인스턴스가 같은 통화를 집지 않게
const LIVE_CALL =
  "c.deleted_at IS NULL AND (c.incoming_at IS NULL OR c.incoming_at>clock_timestamp()-interval '5 years')";

export interface StoredComplaint {
  type: string;
  evidenceText: string;
  offsetSeconds: number | null;
  utteranceOrders: number[];
  target?: string | null;
  level?: string | null;
}

/** 통화 불만 판정(후처리) 저장소 — AI 분석이 들어온 통화 중 아직 판정하지 않은(has_complaint IS NULL) 것을 집고, 결과로 바꾼다 */
@Injectable()
export class ComplaintJudgeRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly faqs: ComplaintFaqClient,
    private readonly audit: AuditService,
  ) {}

  /** 판정할 통화 하나를 집는다(최신부터) — 시도 수를 올리고 임대 시각을 걸어 다른 인스턴스와 겹치지 않게 */
  async claim(): Promise<
    { id: number; attempt: number; analysedAt: Date } | undefined
  > {
    return this.database.transaction(async (client) => {
      const row = (
        await client.query<{ id: number; attempt: number; analysedAt: Date }>(
          `SELECT a.call_session_seq AS id,a.complaint_attempts+1 AS attempt,a.analysed_at AS "analysedAt"
           FROM call_analyses a JOIN call_sessions c ON c.call_session_seq=a.call_session_seq
           WHERE a.has_complaint IS NULL AND a.complaint_attempts<${MAX_TRIES}
             AND EXISTS(SELECT 1 FROM call_insight_events e JOIN call_utterances u ON u.call_utterance_seq=e.call_utterance_seq
               WHERE e.call_session_seq=a.call_session_seq AND e.kind='UTTERANCE')
             AND (a.complaint_retry_at IS NULL OR a.complaint_retry_at<=clock_timestamp()) AND ${LIVE_CALL}
           ORDER BY a.analysed_at DESC LIMIT 1 FOR UPDATE OF a SKIP LOCKED`,
        )
      ).rows[0];
      if (!row) return undefined;
      await client.query(
        `UPDATE call_analyses SET complaint_attempts=complaint_attempts+1,complaint_retry_at=clock_timestamp()+${LEASE}
         WHERE call_session_seq=$1`,
        [row.id],
      );
      return row;
    });
  }

  /** 판정 입력: 이벤트(event_order 순, 발화는 call_utterances 원문) · FAQ 전체 · 녹음 객체 키 */
  async inputs(id: number): Promise<{
    events: CallEvent[];
    faqs: { question: string; answer: string }[];
    recordingKey: string | null;
  }> {
    const pool = this.database.pool;
    const [events, faqs, recording] = await Promise.all([
      pool.query<{
        kind: CallEvent['kind'];
        occurredAt: Date;
        offsetSeconds: number | null;
        payload: Record<string, unknown>;
      }>(
        `SELECT e.kind,e.occurred_at AS "occurredAt",e.offset_seconds::double precision AS "offsetSeconds",
           CASE WHEN e.kind='UTTERANCE' THEN jsonb_build_object('utteranceOrder',u.utterance_order,'speaker',u.speaker,
             'utteranceText',u.utterance_text) ELSE e.payload END AS payload
         FROM call_insight_events e LEFT JOIN call_utterances u ON u.call_utterance_seq=e.call_utterance_seq
         WHERE e.call_session_seq=$1 ORDER BY e.event_order`,
        [id],
      ),
      this.faqs.read(),
      pool.query<{ objectKey: string }>(
        `SELECT object_key AS "objectKey" FROM recordings WHERE call_session_seq=$1
         ORDER BY created_at,recording_seq LIMIT 1`,
        [id],
      ),
    ]);
    return {
      events: events.rows.map((e) => ({
        kind: e.kind,
        occurredAt: e.occurredAt.toISOString(),
        offsetSeconds: e.offsetSeconds,
        payload: e.payload ?? {},
      })),
      faqs,
      recordingKey: recording.rows[0]?.objectKey ?? null,
    };
  }

  /** 판정 결과 저장 — 아직 미판정인 행만(AI가 나중에 판정해 보내는 경우와 겹치지 않게). 화면 · 통계는 이 칸을 그대로 읽는다 */
  async save(
    id: number,
    hasComplaint: boolean,
    complaints: StoredComplaint[],
  ): Promise<boolean> {
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE call_analyses SET has_complaint=$2,complaints=$3::jsonb,complaint_retry_at=NULL
       WHERE call_session_seq=$1 AND has_complaint IS NULL`,
        [id, hasComplaint, JSON.stringify(complaints)],
      );
      if (result.rowCount === 1)
        await this.audit.recordSuccess(
          {
            actorId: null,
            actorType: 'SYSTEM',
            targetType: 'CALL_SESSION',
            targetId: id,
            action: 'CALL_COMPLAINT_JUDGED',
            requestId: randomUUID(),
            metadata: { hasComplaint, complaintCount: complaints.length },
          },
          client,
        );
      return result.rowCount === 1;
    });
  }

  /** 다시 집을 시각을 정한다. 시도 수를 쓰지 않을 때(녹음을 기다림)는 올린 시도 수를 되돌린다 */
  async retryLater(
    id: number,
    minutes: number,
    countAttempt: boolean,
    reason: 'MODEL_UNAVAILABLE' | 'RECORDING_UNAVAILABLE' = 'MODEL_UNAVAILABLE',
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE call_analyses SET complaint_retry_at=clock_timestamp()+make_interval(mins=>$2),
         complaint_attempts=complaint_attempts-$3
       WHERE call_session_seq=$1 AND has_complaint IS NULL`,
        [id, minutes, countAttempt ? 0 : 1],
      );
      if (countAttempt && result.rowCount)
        await this.audit.recordResult(
          {
            actorId: null,
            actorType: 'SYSTEM',
            targetType: 'CALL_SESSION',
            targetId: id,
            action: 'CALL_COMPLAINT_FAILED',
            requestId: randomUUID(),
            metadata: { reason },
          },
          'FAILED',
          client,
        );
    });
  }

  /** 판정할 수 없는 통화 — 다시 집지 않는다 (미판정으로 남음) */
  async giveUp(id: number): Promise<void> {
    await this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE call_analyses SET complaint_attempts=${GIVE_UP},complaint_retry_at=NULL
       WHERE call_session_seq=$1 AND has_complaint IS NULL`,
        [id],
      );
      if (result.rowCount)
        await this.audit.recordResult(
          {
            actorId: null,
            actorType: 'SYSTEM',
            targetType: 'CALL_SESSION',
            targetId: id,
            action: 'CALL_COMPLAINT_FAILED',
            requestId: randomUUID(),
            metadata: { reason: 'INPUT_TOO_LONG' },
          },
          'FAILED',
          client,
        );
    });
  }
}
