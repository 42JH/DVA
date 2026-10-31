import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { CallInsightsRepository } from './call-insights.repository';
import { CreateCallAnalysisDto } from './dto/create-call-analysis.dto';

@Injectable()
export class CallInsightsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: CallInsightsRepository,
    private readonly audit: AuditService,
  ) {}

  async save(id: number, input: CreateCallAnalysisDto, requestId: string): Promise<void> {
    const start = new Date(input.startedAt);
    const end = new Date(input.endedAt);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      start.getUTCFullYear() < 1 ||
      end.getUTCFullYear() < 1 ||
      end < start
    )
      throw new ApiException(422, 'VALIDATION_FAILED', '통화 시작·종료 시각을 확인해 주세요.');
    if (input.hasComplaint === true ? input.complaints.length === 0 : input.complaints.length !== 0)
      throw new ApiException(400, 'INVALID_REQUEST', '불만 여부와 불만 근거를 함께 확인해 주세요.');

    const normalized: CreateCallAnalysisDto = {
      providerCallId: input.providerCallId,
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      aiPersonaVersionSeq: input.aiPersonaVersionSeq,
      result: input.result,
      repeatQuestionCount: input.repeatQuestionCount,
      hasComplaint: input.hasComplaint,
      complaints: input.complaints.map((complaint) => ({
        type: complaint.type,
        evidenceText: complaint.evidenceText,
        offsetSeconds: complaint.offsetSeconds,
        utteranceOrders: [...complaint.utteranceOrders].sort((a, b) => a - b),
      })),
    };
    const payloadHash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');

    await this.database.transaction(async (client) => {
      const providerCallId = await this.repository.findProviderCallId(client, id);
      if (providerCallId === undefined)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (providerCallId !== input.providerCallId)
        throw new ApiException(403, 'FORBIDDEN', '통화 번호와 AI 통화 ID가 일치하지 않습니다.');
      if (
        input.aiPersonaVersionSeq !== null &&
        !(await this.repository.personaVersionExists(client, input.aiPersonaVersionSeq))
      )
        throw new ApiException(404, 'NOT_FOUND', '실제 사용한 페르소나 버전을 찾을 수 없습니다.');

      if (!(await this.repository.insert(client, id, normalized, payloadHash))) {
        if ((await this.repository.findPayloadHash(client, id)) !== payloadHash)
          throw new ApiException(
            409,
            'EVENT_PAYLOAD_CONFLICT',
            '이미 저장한 통화 분석과 내용이 다릅니다.',
          );
        return;
      }
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'AI',
          action: 'CALL_ANALYSIS_RECORDED',
          targetType: 'CALL_SESSION',
          targetId: id,
          requestId,
        },
        client,
      );
    });
  }
}
