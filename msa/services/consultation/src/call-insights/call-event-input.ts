import { ApiException } from '../common/errors/api.exception';
import {
  AiActionPayloadDto,
  BusinessResultPayloadDto,
  CallEventInputDto,
  UtterancePayloadDto,
} from './dto/create-call-events.dto';

export function normalizeCallEvents(
  input: CallEventInputDto[],
): CallEventInputDto[] {
  const events = input.map((event): CallEventInputDto => {
    const occurredAt = new Date(event.occurredAt);
    if (
      !Number.isFinite(occurredAt.getTime()) ||
      occurredAt.getUTCFullYear() < 1
    )
      throw new ApiException(
        422,
        'VALIDATION_FAILED',
        '이벤트 발생 시각을 확인해 주세요.',
      );
    let payload: CallEventInputDto['payload'];
    if (event.kind === 'UTTERANCE') {
      const value = event.payload as UtterancePayloadDto;
      payload = {
        utteranceOrder: value.utteranceOrder,
        speaker: value.speaker,
        utteranceText: value.utteranceText,
        lastSentenceSeq: value.lastSentenceSeq,
      };
    } else if (event.kind === 'AI_ACTION') {
      const value = event.payload as AiActionPayloadDto;
      payload = {
        action: value.action,
        summaryText: value.summaryText,
        orderSeq: value.orderSeq,
      };
    } else {
      const value = event.payload as BusinessResultPayloadDto;
      payload = {
        action: value.action,
        orderSeq: value.orderSeq,
        unansweredQuestionSeq: value.unansweredQuestionSeq,
        summaryText: value.summaryText,
      };
      if (value.action === 'FAQ_ANSWERED') {
        if (value.orderSeq !== null || value.unansweredQuestionSeq !== null)
          throw new ApiException(
            422,
            'VALIDATION_FAILED',
            'FAQ 답변 결과의 주문·미답변 번호는 null이어야 합니다.',
          );
        if (value.faqEntrySeq !== undefined && value.faqEntrySeqs !== undefined)
          throw new ApiException(
            400,
            'INVALID_REQUEST',
            'FAQ 단건 번호와 번호 배열은 함께 보낼 수 없습니다.',
          );
        Object.assign(
          payload,
          value.faqEntrySeqs !== undefined
            ? { faqEntrySeqs: [...value.faqEntrySeqs].sort((a, b) => a - b) }
            : { faqEntrySeq: value.faqEntrySeq },
          {
            questionUtteranceOrder: value.questionUtteranceOrder,
            answerUtteranceOrder: value.answerUtteranceOrder,
          },
        );
      } else if (
        [
          value.faqEntrySeq,
          value.faqEntrySeqs,
          value.questionUtteranceOrder,
          value.answerUtteranceOrder,
        ].some((field) => field !== undefined)
      )
        throw new ApiException(
          400,
          'INVALID_REQUEST',
          'FAQ 답변 참조는 FAQ_ANSWERED에만 보냅니다.',
        );
    }
    return {
      eventId: event.eventId.toLowerCase(),
      eventOrder: event.eventOrder,
      kind: event.kind,
      occurredAt: occurredAt.toISOString(),
      offsetSeconds: event.offsetSeconds,
      payload,
    };
  });
  if (
    new Set(events.map((event) => event.eventId)).size !== events.length ||
    new Set(events.map((event) => event.eventOrder)).size !== events.length
  )
    throw new ApiException(
      400,
      'INVALID_REQUEST',
      '요청 묶음 안의 이벤트 ID·순번은 중복될 수 없습니다.',
    );
  return events;
}
