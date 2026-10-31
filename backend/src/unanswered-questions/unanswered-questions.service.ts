import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { CreateUnansweredQuestionDto } from './dto/create-unanswered-question.dto';
import { UnansweredQuestionsRepository } from './unanswered-questions.repository';

@Injectable()
export class UnansweredQuestionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: UnansweredQuestionsRepository,
    private readonly audit: AuditService,
  ) {}

  async collect(input: CreateUnansweredQuestionDto, requestId: string) {
    const occurredAt = new Date(input.occurredAt);
    if (!Number.isFinite(occurredAt.getTime()) || occurredAt.getUTCFullYear() < 1)
      throw new ApiException(422, 'VALIDATION_FAILED', '질문 발생 시각을 확인해 주세요.');
    const normalized: CreateUnansweredQuestionDto = {
      eventId: input.eventId.toLowerCase(),
      callSessionSeq: input.callSessionSeq,
      providerCallId: input.providerCallId,
      questionText: input.questionText,
      occurredAt: occurredAt.toISOString(),
      offsetSeconds: input.offsetSeconds,
    };
    const hash = createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
    return this.database.transaction(async (client) => {
      const providerCallId = await this.repository.findCall(client, normalized.callSessionSeq);
      if (providerCallId === undefined)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (providerCallId !== normalized.providerCallId)
        throw new ApiException(403, 'FORBIDDEN', '통화 번호와 AI 통화 ID가 일치하지 않습니다.');
      const id = await this.repository.insert(client, normalized, hash);
      if (id !== undefined) {
        await this.audit.recordSuccess(
          {
            actorId: null,
            actorType: 'AI',
            action: 'UNANSWERED_QUESTION_RECORDED',
            targetType: 'UNANSWERED_QUESTION',
            targetId: id,
            requestId,
          },
          client,
        );
        return { id, created: true };
      }
      const existing = await this.repository.findExisting(client, normalized.eventId);
      if (
        !existing ||
        existing.callSessionSeq !== normalized.callSessionSeq ||
        existing.hash !== hash
      )
        throw new ApiException(
          409,
          'EVENT_PAYLOAD_CONFLICT',
          '이미 저장한 질문 발생과 내용이 다릅니다.',
        );
      // 삭제·FAQ 전환 뒤에도 원문이나 업무 상태를 다시 쓰지 않는다.
      return { id: existing.id, created: false };
    });
  }
}
