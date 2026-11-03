import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import { CallEventsRepository } from './call-events.repository';
import { normalizeCallEvents } from './call-event-input';
import {
  AiActionPayloadDto,
  BusinessResultPayloadDto,
  CreateCallEventsDto,
  UtterancePayloadDto,
} from './dto/create-call-events.dto';

@Injectable()
export class CallEventsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: CallEventsRepository,
    private readonly audit: AuditService,
  ) {}

  async findActions(id: number, query: PaginationQueryDto) {
    if (!(await this.repository.callExists(id)))
      throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    return new ListResponse(await this.repository.findActions(id, query), query.limit);
  }

  async findProcessingResults(id: number, query: PaginationQueryDto) {
    if (!(await this.repository.callExists(id)))
      throw new ApiException(404, 'NOT_FOUND', '통화 기록을 찾을 수 없습니다.');
    return new ListResponse(await this.repository.findProcessingResults(id, query), query.limit);
  }

  async save(id: number, input: CreateCallEventsDto, requestId: string): Promise<void> {
    const events = normalizeCallEvents(input.events);
    const conflict = () =>
      new ApiException(
        409,
        'EVENT_PAYLOAD_CONFLICT',
        '이미 저장한 이벤트·순번·발화와 내용이 다릅니다.',
      );
    await this.database.transaction(async (client) => {
      const call = await this.repository.findCall(client, id);
      if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
      if (call.providerCallId !== input.providerCallId)
        throw new ApiException(403, 'FORBIDDEN', '통화 번호와 AI 통화 ID가 일치하지 않습니다.');
      let inserted = false;
      const faqResults: BusinessResultPayloadDto[] = [];
      // 서로 다른 통화에서 잘못 재사용한 UUID도 같은 잠금 순서로 처리한다.
      for (const event of events.sort((a, b) => a.eventId.localeCompare(b.eventId))) {
        const hash = createHash('sha256')
          .update(
            JSON.stringify({ callSessionSeq: id, providerCallId: input.providerCallId, ...event }),
          )
          .digest('hex');
        const existing = await this.repository.findExisting(client, id, event);
        const matches = (rows: typeof existing) =>
          rows.length === 1 &&
          rows[0].eventId === event.eventId &&
          rows[0].callId === id &&
          rows[0].eventOrder === event.eventOrder &&
          rows[0].hash === hash;
        if (existing.length) {
          if (!matches(existing)) throw conflict();
          continue;
        }
        let utteranceId: number | null = null;
        let questionId: number | null = null;
        if (event.kind === 'UTTERANCE') {
          const payload = event.payload as UtterancePayloadDto;
          const utterance = await this.repository.findOrInsertUtterance(client, id, payload);
          if (
            !utterance ||
            utterance.speaker !== payload.speaker ||
            utterance.text !== payload.utteranceText ||
            utterance.lastSentenceSeq !== payload.lastSentenceSeq
          )
            throw conflict();
          utteranceId = utterance.id;
        } else {
          const payload = event.payload as AiActionPayloadDto | BusinessResultPayloadDto;
          if (payload.orderSeq !== null) {
            const allowed = await this.repository.orderAccess(client, payload.orderSeq, call);
            if (allowed === undefined)
              throw new ApiException(404, 'NOT_FOUND', '참조 주문을 찾을 수 없습니다.');
            if (!allowed)
              throw new ApiException(403, 'FORBIDDEN', '통화 고객의 주문만 참조할 수 있습니다.');
          }
          if (event.kind === 'BUSINESS_RESULT') {
            questionId = (payload as BusinessResultPayloadDto).unansweredQuestionSeq;
            if (questionId !== null) {
              const questionCall = await this.repository.questionCall(client, questionId);
              if (questionCall === undefined)
                throw new ApiException(404, 'NOT_FOUND', '참조 미답변 질문을 찾을 수 없습니다.');
              if (questionCall !== id)
                throw new ApiException(
                  403,
                  'FORBIDDEN',
                  '같은 통화의 미답변 질문만 참조할 수 있습니다.',
                );
            }
          }
        }
        if (!(await this.repository.insert(client, id, event, hash, utteranceId, questionId))) {
          if (!matches(await this.repository.findExisting(client, id, event))) throw conflict();
        } else {
          inserted = true;
          if (
            event.kind === 'BUSINESS_RESULT' &&
            (event.payload as BusinessResultPayloadDto).action === 'FAQ_ANSWERED'
          )
            faqResults.push(event.payload as BusinessResultPayloadDto);
        }
      }
      // 같은 묶음의 발화가 UUID 정렬 뒤에 있어도 참조할 수 있다.
      for (const result of faqResults) {
        const references = await this.repository.faqReferences(client, id, result);
        if (references.questionSpeaker === null || references.answerSpeaker === null)
          throw new ApiException(
            404,
            'NOT_FOUND',
            '같은 통화의 질문·답변 발화를 찾을 수 없습니다.',
          );
        if (references.questionSpeaker !== 'CUSTOMER' || references.answerSpeaker !== 'AI')
          throw new ApiException(
            422,
            'VALIDATION_FAILED',
            '질문은 고객 발화, 답변은 AI 발화여야 합니다.',
          );
      }
      if (inserted)
        await this.audit.recordSuccess(
          {
            actorId: null,
            actorType: 'AI',
            action: 'CALL_EVENTS_RECORDED',
            targetType: 'CALL_SESSION',
            targetId: id,
            requestId,
          },
          client,
        );
    });
  }
}
