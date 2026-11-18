import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { DatabaseService } from '../database/database.service';
import { UnansweredQuestionsRepository } from './unanswered-questions.repository';
import type { CreateUnansweredQuestionDto } from './dto/create-unanswered-question.dto';
import type { UnansweredQuestionQueryDto } from './dto/unanswered-question-query.dto';
import { ListResponse } from '../common/pagination';
import { retryFaqWrite } from '@dva/events/faq-conversion.cjs';
import type { CreateFaqDto } from './dto/create-faq.dto';
import { ensureFaqConversionsConfirmed } from './faq-conversion';

@Injectable()
export class UnansweredQuestionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: UnansweredQuestionsRepository,
    private readonly audit: AuditService,
  ) {}

  async convert(
    id: number,
    input: CreateFaqDto,
    adminId: number,
    requestId: string,
  ): Promise<number> {
    const hash = createHash('sha256')
      .update(
        JSON.stringify({
          category: input.category,
          question: input.question,
          answer: input.answer,
        }),
      )
      .digest('hex');
    return retryFaqWrite(() =>
      this.database.transaction(async (client) => {
        const question = await this.repository.findForUpdate(client, id);
        if (!question)
          throw new ApiException(
            404,
            'NOT_FOUND',
            '미답변 질문을 찾을 수 없습니다.',
          );
        if (question.status === 'DELETED')
          throw new ApiException(
            409,
            'INVALID_STATE',
            '삭제한 질문은 FAQ로 전환할 수 없습니다.',
          );
        if (question.status === 'REGISTERED') {
          if (question.conversionHash !== hash || question.faqId === null)
            throw new ApiException(
              409,
              'INVALID_STATE',
              '이미 다른 내용으로 FAQ 전환한 질문입니다.',
            );
          await ensureFaqConversionsConfirmed(client);
          if (!(await this.repository.faqExists(question.faqId)))
            throw new ApiException(
              409,
              'INVALID_STATE',
              '전환한 FAQ가 삭제되어 다시 생성할 수 없습니다.',
            );
          return question.faqId;
        }
        const faqId = await this.audit.prepareFaqConversion(client, {
          faq: input,
          adminId,
          requestId,
        });
        await this.repository.register(client, id, faqId, hash);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            action: 'UNANSWERED_QUESTION_REGISTERED',
            targetType: 'UNANSWERED_QUESTION',
            targetId: id,
            requestId,
          },
          client,
        );
        return faqId;
      }),
    );
  }

  async findMany(query: UnansweredQuestionQueryDto) {
    const from = query.from === undefined ? undefined : Date.parse(query.from);
    const to = query.to === undefined ? undefined : Date.parse(query.to);
    if (
      (from === undefined) !== (to === undefined) ||
      (from !== undefined &&
        (!Number.isFinite(from) || new Date(from).getUTCFullYear() < 1)) ||
      (to !== undefined &&
        (!Number.isFinite(to) || new Date(to).getUTCFullYear() < 1)) ||
      (from !== undefined && to !== undefined && from >= to)
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '기간은 시작·종료 시각을 함께 지정하고 시작이 종료보다 빨라야 합니다.',
      );
    return new ListResponse(await this.repository.findMany(query), query.limit);
  }

  async delete(
    id: number | number[],
    adminId: number,
    requestId: string,
  ): Promise<void> {
    const ids = (Array.isArray(id) ? [...id] : [id]).sort((a, b) => a - b);
    await this.database.transaction(async (client) => {
      for (const id of ids) {
        const question = await this.repository.findForUpdate(client, id);
        if (!question)
          throw new ApiException(
            404,
            'NOT_FOUND',
            '미답변 질문을 찾을 수 없습니다.',
          );
        if (question.status === 'REGISTERED')
          throw new ApiException(
            409,
            'INVALID_STATE',
            'FAQ로 전환한 질문은 삭제할 수 없습니다.',
          );
        if (question.status === 'DELETED') continue;
        await this.repository.delete(client, id);
        await this.audit.recordSuccess(
          {
            actorId: adminId,
            action: 'UNANSWERED_QUESTION_DELETED',
            targetType: 'UNANSWERED_QUESTION',
            targetId: id,
            requestId,
          },
          client,
        );
      }
    });
  }

  async collect(input: CreateUnansweredQuestionDto, requestId: string) {
    const occurredAt = new Date(input.occurredAt);
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      occurredAt.getUTCFullYear() < 1
    )
      throw new ApiException(
        422,
        'VALIDATION_FAILED',
        '질문 발생 시각을 확인해 주세요.',
      );
    const normalized: CreateUnansweredQuestionDto = {
      eventId: input.eventId.toLowerCase(),
      callSessionSeq: input.callSessionSeq,
      providerCallId: input.providerCallId,
      questionText: input.questionText,
      occurredAt: occurredAt.toISOString(),
      offsetSeconds: input.offsetSeconds,
      // 미분류는 JSON 해시에서 제외해 기존 여섯 필드의 재전송을 유지한다.
      reason: input.reason ?? undefined,
    };
    const hash = createHash('sha256')
      .update(JSON.stringify(normalized))
      .digest('hex');
    return this.database.transaction(async (client) => {
      const providerCallId = await this.repository.findCall(
        client,
        normalized.callSessionSeq,
      );
      if (providerCallId === undefined)
        throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (providerCallId !== normalized.providerCallId)
        throw new ApiException(
          403,
          'FORBIDDEN',
          '통화 번호와 AI 통화 ID가 일치하지 않습니다.',
        );
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
      const existing = await this.repository.findExisting(
        client,
        normalized.eventId,
      );
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
