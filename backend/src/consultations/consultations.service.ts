import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { ConsultationsRepository } from './consultations.repository';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDetailDto } from './dto/call-response.dto';
import { TranscriptQueryDto } from './dto/transcript.dto';
import { RecordingPlaybackService } from './recording-playback.service';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { CallSessionRepository } from './call-session.repository';
import { CallIdentityDto } from './dto/call-identity.dto';
import { RecordingCallMatch } from './consultations.types';

@Injectable()
export class ConsultationsService {
  constructor(
    private readonly repository: ConsultationsRepository,
    private readonly playback: RecordingPlaybackService,
    private readonly sessions: CallSessionRepository,
    private readonly audit: AuditService,
  ) {}

  async ensureCall(
    client: PoolClient,
    input: CallIdentityDto & { callerPhoneNumber: string },
    actorId: number | null,
    requestId: string,
  ): Promise<number> {
    const session = await this.sessions.ensureCall(client, input);
    if (session.created)
      await this.audit.recordSuccess(
        {
          actorId,
          actorType: actorId === null ? 'AI' : 'ADMIN',
          action: 'CALL_STARTED',
          targetType: 'CALL_SESSION',
          targetId: session.id,
          requestId,
        },
        client,
      );
    return session.id;
  }

  attachOrder(client: PoolClient, callId: number, orderId: number) {
    return this.sessions.attachOrder(client, callId, orderId);
  }

  attachRecording(client: PoolClient, callId: number, objectKey: string) {
    return this.sessions.attachRecording(client, callId, objectKey);
  }

  matchRecording(client: PoolClient, input: RecordingCallMatch) {
    return this.sessions.matchRecording(client, input);
  }

  async findMany(query: CallQueryDto) {
    const from = query.from === undefined ? undefined : Date.parse(query.from);
    const to = query.to === undefined ? undefined : Date.parse(query.to);
    if (
      (from !== undefined && !Number.isFinite(from)) ||
      (to !== undefined && !Number.isFinite(to)) ||
      (from !== undefined && to !== undefined && from >= to)
    )
      throw new ApiException(400, 'INVALID_REQUEST', '시작 시각은 종료 시각보다 빨라야 합니다.');
    return new ListResponse(await this.repository.findMany(query), query.limit);
  }

  async findOne(id: number): Promise<CallDetailDto> {
    const row = await this.repository.findOne(id);
    if (!row) throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    const { analysis, ...call } = row;
    const recordings = await this.repository.findRecordings(id);
    return {
      call,
      analysis,
      aiActionCount: await this.repository.countActions(id),
      recordings: await Promise.all(
        recordings.map(async ({ objectKey, ...recording }) => ({
          ...recording,
          ...(await this.playback.create(objectKey)),
        })),
      ),
    };
  }

  async findTranscript(id: number, query: TranscriptQueryDto) {
    if (!(await this.repository.findOne(id)))
      throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    return new ListResponse(await this.repository.findTranscript(id, query), query.limit);
  }
}
