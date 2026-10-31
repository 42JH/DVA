import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  NotContains,
  ValidateIf,
} from 'class-validator';

export class CreateUnansweredQuestionDto {
  @ApiProperty({ format: 'uuid', description: '질문 발생 시 생성하고 재전송에도 유지하는 식별자.' })
  @IsUUID()
  eventId!: string;

  @ApiProperty({ minimum: 1, maximum: 2147483647, description: '질문이 발생한 기존 통화 번호.' })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  callSessionSeq!: number;

  @ApiProperty({ maxLength: 200, description: '해당 통화에 저장된 실제 AI 세션 식별자.' })
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\s\u0000]+$/)
  providerCallId!: string;

  @ApiProperty({
    maxLength: 1000,
    description: '답변하지 못한 고객 질문 원문. 공백·줄바꿈을 보존합니다.',
  })
  @IsString()
  @MaxLength(1000)
  @Matches(/\S/u)
  @NotContains('\u0000')
  questionText!: string;

  @ApiProperty({
    format: 'date-time',
    description: '시간대를 포함한 질문 발생 시각. 재전송 시 바꾸지 않습니다.',
  })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  occurredAt!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
    description: 'AI 통화 시작부터의 정수 초. 위치를 모르면 null.',
    example: 80,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  offsetSeconds!: number | null;
}
