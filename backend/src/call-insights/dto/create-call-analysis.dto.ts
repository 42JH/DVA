import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  NotContains,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CALL_COMPLAINT_TYPES, CallComplaintType } from '../call-insights.types';

export class CallComplaintDto {
  @ApiProperty({ enum: CALL_COMPLAINT_TYPES, example: 'REPEATED_QUESTION' })
  @IsIn(CALL_COMPLAINT_TYPES)
  type!: CallComplaintType;

  @ApiProperty({ description: '불만으로 판단한 발언·상황. 원문을 보존합니다.', maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  @Matches(/\S/u)
  @NotContains('\u0000')
  evidenceText!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'AI 통화 시작부터 불만 구간까지의 정수 초. 확인할 수 없으면 null.',
    example: 31,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  offsetSeconds!: number | null;

  @ApiProperty({
    type: [Number],
    description: '같은 통화에서 강조할 발화 순번. 연결을 모르면 빈 배열입니다.',
    example: [3, 4, 5, 6],
  })
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  utteranceOrders!: number[];
}

export class CreateCallAnalysisDto {
  @ApiProperty({ description: '경로 통화에 저장된 AI 통화 ID.', maxLength: 200 })
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\s\u0000]+$/)
  providerCallId!: string;

  @ApiProperty({ format: 'date-time', description: '시간대를 포함한 AI 측정 통화 시작.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  startedAt!: string;

  @ApiProperty({ format: 'date-time', description: '시간대를 포함한 AI 측정 통화 종료.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  endedAt!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 2147483647,
    description: '실제 사용한 설정 이력의 DB 번호. 미확인은 null.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  aiPersonaVersionSeq!: number | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description: 'AI가 판정한 신규 고객 true / 기존 고객 false. 생략·null은 미수집.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsBoolean()
  isNewCustomer?: boolean | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI가 집계한 접수 확정 배송 상세 수. 결제 대기 포함. 생략·null은 미수집.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  registeredParcelCount?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI가 집계한 FAQ 답변 건수. 생략·null은 미수집.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  faqAnswerCount?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI가 집계한 접수 내역 조회·안내 건수. 생략·null은 미수집.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  orderLookupCount?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI가 집계한 취소 완료 배송 상세 수. 생략·null은 미수집.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  cancelledParcelCount?: number | null;

  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description: '상담원 연결을 요구했으면 true. 실제 연결 성공과 별개이며 생략·null은 미수집.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsBoolean()
  hasHandoffRequest?: boolean | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2147483647,
    description: 'AI가 되물은 횟수. 미측정은 null, 측정 후 없음은 0.',
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  repeatQuestionCount!: number | null;

  @ApiProperty({ type: Boolean, nullable: true, description: '불만 유무. 미판정은 null.' })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsBoolean()
  hasComplaint!: boolean | null;

  @ApiProperty({ type: [CallComplaintDto], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => CallComplaintDto)
  complaints!: CallComplaintDto[];
}
