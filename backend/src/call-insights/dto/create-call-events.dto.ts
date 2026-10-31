import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  NotContains,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  AI_ACTIONS,
  BUSINESS_ACTIONS,
  CALL_EVENT_KINDS,
  CallEventKind,
} from '../call-events.types';

export class UtterancePayloadDto {
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  utteranceOrder!: number;

  @ApiProperty({ enum: ['CUSTOMER', 'AI'] })
  @IsIn(['CUSTOMER', 'AI'])
  speaker!: 'CUSTOMER' | 'AI';

  @ApiProperty({ maxLength: 20000, description: '완결된 발화 구간의 원문.' })
  @IsString()
  @MaxLength(20000)
  @Matches(/\S/u)
  @NotContains('\u0000')
  utteranceText!: string;

  @ApiProperty({
    minimum: 1,
    maximum: 2147483647,
    description: '구간에 마지막으로 반영된 문장 순번.',
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  lastSentenceSeq!: number;
}

export class AiActionPayloadDto {
  @ApiProperty({
    enum: AI_ACTIONS,
    description:
      'PIN_SEARCH는 저장 PIN 검색, PREVIOUS_ORDER_SEARCH는 이전 주문 검색이며 주소에 한정하지 않는다. ADDRESS_SEARCH·ORDER_LOOKUP은 기존 기록 호환용이다.',
  })
  @IsIn(AI_ACTIONS)
  action!: (typeof AI_ACTIONS)[number];

  @ApiProperty({ maxLength: 1000, description: '동작 결과 설명. 실패도 이 내용으로 기록한다.' })
  @IsString()
  @MaxLength(1000)
  @Matches(/\S/u)
  @NotContains('\u0000')
  summaryText!: string;

  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 2147483647 })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  orderSeq!: number | null;
}

export class BusinessResultPayloadDto {
  @ApiProperty({ enum: BUSINESS_ACTIONS })
  @IsIn(BUSINESS_ACTIONS)
  action!: (typeof BUSINESS_ACTIONS)[number];

  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 2147483647 })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  orderSeq!: number | null;

  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 2147483647 })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  unansweredQuestionSeq!: number | null;

  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  @Matches(/\S/u)
  @NotContains('\u0000')
  summaryText!: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: 'FAQ_ANSWERED에서 필수인 사용 FAQ 번호. 다른 action에서는 생략한다.',
  })
  @ValidateIf(
    (payload: BusinessResultPayloadDto, value: unknown) =>
      payload.action === 'FAQ_ANSWERED' || value !== undefined,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  faqEntrySeq?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: 'FAQ_ANSWERED에서 필수인 같은 통화 고객 질문의 utteranceOrder.',
  })
  @ValidateIf(
    (payload: BusinessResultPayloadDto, value: unknown) =>
      payload.action === 'FAQ_ANSWERED' || value !== undefined,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  questionUtteranceOrder?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: 'FAQ_ANSWERED에서 필수인 같은 통화 AI 답변의 utteranceOrder.',
  })
  @ValidateIf(
    (payload: BusinessResultPayloadDto, value: unknown) =>
      payload.action === 'FAQ_ANSWERED' || value !== undefined,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  answerUtteranceOrder?: number;
}

export class CallEventInputDto {
  @ApiProperty({ format: 'uuid', description: '발생 시 생성하고 재전송에도 유지한다.' })
  @IsUUID()
  eventId!: string;

  @ApiProperty({
    minimum: 1,
    maximum: 2147483647,
    description: '요청 묶음과 별개인 통화 전체 순번.',
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  eventOrder!: number;

  @ApiProperty({ enum: CALL_EVENT_KINDS })
  @IsIn(CALL_EVENT_KINDS)
  kind!: CallEventKind;

  @ApiProperty({ format: 'date-time', description: '시간대를 포함한 실제 발생 시각.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  occurredAt!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'AI 통화 시작부터의 정수 초. 확인할 수 없으면 null.',
    example: 31,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  offsetSeconds!: number | null;

  @ApiProperty({
    anyOf: [UtterancePayloadDto, AiActionPayloadDto, BusinessResultPayloadDto].map((type) => ({
      $ref: getSchemaPath(type),
    })),
  })
  @IsObject()
  @ValidateNested()
  @Type((options) => {
    switch (options?.object.kind) {
      case 'UTTERANCE':
        return UtterancePayloadDto;
      case 'AI_ACTION':
        return AiActionPayloadDto;
      case 'BUSINESS_RESULT':
        return BusinessResultPayloadDto;
      default:
        return Object;
    }
  })
  payload!: UtterancePayloadDto | AiActionPayloadDto | BusinessResultPayloadDto;
}

export class CreateCallEventsDto {
  @ApiProperty({ maxLength: 200, description: '경로 통화에 저장된 실제 AI 통화 ID.' })
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\s\u0000]+$/)
  providerCallId!: string;

  @ApiProperty({
    type: [CallEventInputDto],
    minItems: 1,
    maxItems: 50,
    description: '요청당 1~50개. 통화 누적 개수 제한이 아니다. 전체 본문은 최대 100KiB.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => CallEventInputDto)
  events!: CallEventInputDto[];
}
