import { CallDraftDeletionClient } from './call-draft-deletion.client';
import { DatabaseService } from '../database/database.service';
import { ConsultationsRepository } from './consultations.repository';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import type { TranscriptQueryDto } from './dto/transcript.dto';
import { AuditService } from '../audit/audit.service';
import { CallIdentityDto } from './dto/call-identity.dto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CallSessionRepository } from './call-session.repository';
import { CallEndRepository } from './call-end.repository';
import type { CallEndedPayload } from '../webhooks/pbx/pbx-webhook.payload';
@Injectable()
export class ConsultationsService {
  constructor(
    private readonly sessions: CallSessionRepository,
    private readonly endings: CallEndRepository,
    private readonly audit: AuditService,
    private readonly repository: ConsultationsRepository,
    private readonly database: DatabaseService,
    private readonly draftDeletion: CallDraftDeletionClient,
  ) {}
  attachRecording(client: PoolClient, callId: number, objectKey: string) {
    return this.sessions.attachRecording(client, callId, objectKey);
  }
  matchCallEnd(
    client: PoolClient,
    input: CallEndedPayload,
    windowSeconds?: number,
    claimId?: string,
  ) {
    return this.endings.match(client, input, windowSeconds, claimId);
  }
  async ensureCall(
    client: PoolClient,
    input: CallIdentityDto & { callerPhoneNumber: string },
    actorId: number | null,
    requestId: string,
    customerId: number | null,
  ): Promise<number> {
    await this.endings.lockCaller(client, input.callerPhoneNumber);
    const session = await this.sessions.ensureCall(client, input, customerId);
    await this.endings.matchPending(
      client,
      input.callerPhoneNumber,
      input.incomingAt,
    );
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

  attachCustomer(client: PoolClient, callId: number, customerId: number) {
    return this.sessions.attachCustomer(client, callId, customerId);
  }

  async delete(id: number, adminId: number, requestId: string): Promise<void> {
    await this.database
      .transaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='2s'");
        const call = await this.repository.lockForDeletion(client, id);
        if (!call)
          throw new ApiException(
            404,
            'NOT_FOUND',
            '통화 기록을 찾을 수 없습니다.',
          );
        if (
          !call.endedAt ||
          (await this.repository.recordingInProgress(client, id))
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '통화 종료와 녹취 저장이 완료된 뒤 삭제해 주세요.',
          );
        if (
          call.orderFinalizedAt === null &&
          (await this.draftDeletion.blocked(id))
        )
          throw new ApiException(
            409,
            'INVALID_STATE',
            '배송 초안의 주문 확정을 마친 뒤 통화를 삭제해 주세요.',
          );
        await this.repository.softDelete(client, id);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            targetId: id,
            targetType: 'CALL_SESSION',
            action: 'CALL_DELETED',
            requestId,
          },
          client,
        );
      })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === '55P03'
        )
          throw new ApiException(
            409,
            'REQUEST_IN_PROGRESS',
            '다른 통화 처리가 진행 중입니다. 잠시 후 재시도해 주세요.',
          );
        throw error;
      });
  }

  async findTranscript(id: number, query: TranscriptQueryDto) {
    if (!(await this.repository.callExists(id)))
      throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    return new ListResponse(
      await this.repository.findTranscript(id, query),
      query.limit,
    );
  }
}
