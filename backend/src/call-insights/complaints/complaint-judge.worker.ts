import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Environment } from '../../config/environment';
import { MAX_INPUT_CHARS, describe, fromEvents, run } from './complaint-judge';
import { backendComplaints } from './complaint-extract';
import { MAX_TRIES, ComplaintJudgeRepository } from './complaint-judge.repository';
import { ComplaintModelClient } from './complaint-model.client';
import { Segment, speechSegments } from './complaint-timing';
import { AuditService } from '../../audit/audit.service';
import { randomUUID } from 'node:crypto';

const TICK_MS = 5000;
const MAX_RECORDING_BYTES = 32 * 1024 * 1024;
const RECORDING_WAIT_MIN = 30; // 녹음 저장이 AI 분석보다 늦을 수 있어 분석 뒤 이만큼은 녹음을 기다림(응답 지연 판정에 필요)

/** 통화 불만 판정 워커 (후처리, Jira 148) — AI 분석이 저장된 통화를 최신부터 판정해 call_analyses의 불만 칸을 채운다.
 *  지난 통화도 같은 방식으로 채워진다. 전용 키(CALL_ANALYSIS_OPENAI_API_KEY)가 없으면 꺼져 있다.
 *  대본 · 판정 사유는 개인정보라 로그에 통화 번호 · 결과 종류만 남긴다 */
@Injectable()
export class ComplaintJudgeWorker
  implements OnApplicationBootstrap, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(ComplaintJudgeWorker.name);
  private readonly s3: S3Client;
  private timer?: NodeJS.Timeout;
  private filling?: Promise<void>;
  private readonly running = new Set<Promise<void>>();
  private stopped = false;

  constructor(
    private readonly repository: ComplaintJudgeRepository,
    private readonly model: ComplaintModelClient,
    private readonly config: ConfigService<Environment, true>,
    private readonly audit: AuditService,
  ) {
    this.s3 = new S3Client({
      region: config.get('AWS_REGION', { infer: true }),
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 5000, requestTimeout: 30000 },
    });
  }

  onApplicationBootstrap(): void {
    if (!this.model.enabled()) return;
    this.timer = setInterval(() => void this.fill(), TICK_MS);
    this.timer.unref();
    void this.fill();
  }

  /** 빈 자리만큼 통화를 집어 판정을 시작한다 */
  fill(): Promise<void> {
    if (this.filling) return this.filling;
    this.filling = this.fillSlots().finally(() => {
      this.filling = undefined;
    });
    return this.filling;
  }

  private async fillSlots(): Promise<void> {
    const limit = this.config.get('CALL_ANALYSIS_CONCURRENCY', { infer: true });
    while (!this.stopped && this.running.size < limit) {
      let claimed: Awaited<ReturnType<ComplaintJudgeRepository['claim']>>;
      try {
        claimed = await this.repository.claim();
      } catch {
        this.logger.warn({ event: 'call_complaint_claim_deferred' });
        return;
      }
      if (!claimed || this.stopped) return;
      const job: Promise<void> = this.judge(claimed.id, claimed.attempt, claimed.analysedAt)
        .catch(async (error: unknown) => {
          await this.audit.recordFailure(
            {
              actorId: null,
              actorType: 'SYSTEM',
              targetType: 'CALL_SESSION',
              targetId: claimed.id,
              action: 'CALL_COMPLAINT_FAILED',
              requestId: randomUUID(),
            },
            error,
          );
          this.logger.warn({ event: 'call_complaint_failed', callSessionSeq: claimed.id });
        })
        .finally(() => this.running.delete(job));
      this.running.add(job);
    }
  }

  private async judge(id: number, attempt: number, analysedAt: Date): Promise<void> {
    const started = Date.now();
    const inputs = await this.repository.inputs(id);
    let speech: Segment[] | null = null;
    if (inputs.recordingKey) {
      try {
        speech = await this.speech(inputs.recordingKey);
      } catch {
        if (attempt < MAX_TRIES) {
          await this.repository.retryLater(id, 10, true, 'RECORDING_UNAVAILABLE');
          this.logger.warn({ event: 'call_complaint_recording_unavailable', callSessionSeq: id });
          return;
        }
        // 마지막 시도: 녹음 없이 판정(응답 지연만 빠짐)
      }
    } else if (Date.now() - analysedAt.getTime() < RECORDING_WAIT_MIN * 60_000) {
      await this.repository.retryLater(id, 5, false);
      return;
    }
    const rec = fromEvents(inputs.events, `call-${id}`, speech);
    if (!rec.turns.length) {
      await this.repository.retryLater(id, 5, false);
      return;
    }
    if ([...describe(rec)].length > MAX_INPUT_CHARS) {
      await this.repository.giveUp(id);
      this.logger.warn({ event: 'call_complaint_input_too_long', callSessionSeq: id });
      return;
    }
    const result = await run(rec, this.model.ask, inputs.faqs.length ? inputs.faqs : null);
    if (!result) {
      await this.repository.retryLater(id, 10 * attempt, true);
      this.logger.warn({ event: 'call_complaint_model_unavailable', callSessionSeq: id, attempt });
      return;
    }
    const { hasComplaint, complaints } = backendComplaints(result, rec);
    if (!(await this.repository.save(id, hasComplaint, complaints))) return;
    this.logger.log({
      event: 'call_complaint_judged',
      callSessionSeq: id,
      hasComplaint,
      complaintCount: complaints.length,
      durationMs: Date.now() - started,
    });
  }

  /** 녹음(WAV) → 말소리 구간. 녹음 저장소가 없으면 null(응답 지연 없이 판정) */
  private async speech(objectKey: string): Promise<Segment[] | null> {
    const bucket = this.config.get('S3_RECORDINGS_BUCKET', { infer: true });
    if (!bucket) return null;
    const object = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }), {
      abortSignal: AbortSignal.timeout(30000),
    });
    if ((object.ContentLength ?? 0) > MAX_RECORDING_BYTES) return null;
    const bytes = await object.Body?.transformToByteArray();
    return bytes ? speechSegments(Buffer.from(bytes)) : null;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.filling;
    await Promise.allSettled([...this.running]);
  }

  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}
