import { ApiProperty } from '@nestjs/swagger';
import { AI_ACTIONS, BUSINESS_ACTIONS } from '../call-events.types';

class CallEventRecordDto {
  @ApiProperty({ format: 'uuid', description: '수집 시 보존한 이벤트 식별자.' })
  eventId!: string;

  @ApiProperty({ minimum: 1, description: '통화 전체 순번. 종류별로 다시 매기지 않습니다.' })
  eventOrder!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'AI가 보고한 발생 시각. UTC ISO 8601.',
  })
  occurredAt!: Date;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    description: 'AI 통화 시작부터 정수 초. 미확인 시 null.',
  })
  offsetSeconds!: number | null;

  @ApiProperty({ description: '기록된 처리 설명. HTML로 해석하지 않는 평문.' })
  summaryText!: string;

  @ApiProperty({ type: Number, nullable: true, description: '연결 주문 번호. 없으면 null.' })
  orderSeq!: number | null;
}

export class CallActionDto extends CallEventRecordDto {
  @ApiProperty({
    enum: AI_ACTIONS,
    description:
      'PIN_SEARCH 저장 PIN 검색, PREVIOUS_ORDER_SEARCH 이전 주문 검색. 주소에 한정하지 않습니다. ADDRESS_SEARCH·ORDER_LOOKUP은 이전 계약 호환용입니다.',
  })
  action!: (typeof AI_ACTIONS)[number];
}

export class CallProcessingResultDto extends CallEventRecordDto {
  @ApiProperty({
    enum: BUSINESS_ACTIONS,
    description: '주문·FAQ 답변·미답변·상담원 연결 요청 등 업무 처리 결과.',
  })
  action!: (typeof BUSINESS_ACTIONS)[number];

  @ApiProperty({ type: Number, nullable: true, description: '연결 미답변 질문 번호. 없으면 null.' })
  unansweredQuestionSeq!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'FAQ 질문 발화 원문 또는 미답변 원문. 미답변 삭제 후 null.',
  })
  questionText!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'FAQ_ANSWERED의 실제 AI 답변 발화 원문. 다른 결과는 null.',
  })
  answerText!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '답변에 사용한 FAQ 번호. FAQ 삭제 후에도 역사적 번호를 보존합니다.',
  })
  faqEntrySeq!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '같은 통화 고객 질문의 utteranceOrder. FAQ 답변 외에는 null.',
  })
  questionUtteranceOrder!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '같은 통화 AI 답변의 utteranceOrder. FAQ 답변 외에는 null.',
  })
  answerUtteranceOrder!: number | null;
}

export class CallActionListResponseDto {
  @ApiProperty({ type: [CallActionDto], description: '통화 순번으로 정렬한 AI 동작 목록.' })
  data!: CallActionDto[];

  @ApiProperty({ description: '다음 페이지 존재 여부.' })
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}

export class CallProcessingResultListResponseDto {
  @ApiProperty({
    type: [CallProcessingResultDto],
    description: '통화 순번으로 정렬한 업무 처리 결과 목록.',
  })
  data!: CallProcessingResultDto[];

  @ApiProperty({ description: '다음 페이지 존재 여부.' })
  hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
