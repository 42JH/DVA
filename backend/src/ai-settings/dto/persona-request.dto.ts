import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { TURN_WAIT_LEVELS, TurnWaitLevel } from '../ai-settings.types';

export class CreatePersonaDto {
  @ApiProperty({
    description: '변경하지 않는 고유 코드. 대소문자를 구분합니다.',
    example: 'parcel',
  })
  @IsString()
  @Matches(/\S/)
  code!: string;

  @ApiProperty({ description: '페르소나 표시명.', example: '친절한 택배 상담원' })
  @IsString()
  @Matches(/\S/)
  name!: string;

  @ApiProperty({
    description: '역할·말투·응대 규칙을 포함한 전체 프롬프트. 원문을 보존합니다.',
    example: '차분한 한국어로 택배 접수를 안내합니다.',
  })
  @IsString()
  @Matches(/\S/)
  promptText!: string;

  @ApiPropertyOptional({
    description: 'GET /api/ai/options의 음성 ID. 생략·null은 AI 기본 음성.',
    type: String,
    nullable: true,
    default: null,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined)
  @IsString()
  @Matches(/\S/)
  voiceId: string | null = null;

  @ApiPropertyOptional({
    description: 'AI가 제공한 min~max 안의 속도. 생략·null은 기본 속도. 미지원이면 null만 허용.',
    type: Number,
    nullable: true,
    default: null,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null && value !== undefined)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(Number.MIN_VALUE)
  speakingRate: number | null = null;

  @ApiPropertyOptional({
    description: 'AI가 실제 지원하는 말끝 대기 단계. NORMAL은 기본 대기.',
    enum: TURN_WAIT_LEVELS,
    default: 'NORMAL',
  })
  @IsIn(TURN_WAIT_LEVELS)
  turnWaitLevel: TurnWaitLevel = 'NORMAL';
}

// PATCH에서 생성 DTO의 기본값이 생략한 필드를 지우지 않도록 따로 선언한다.
export class UpdatePersonaDto extends PartialType(
  OmitType(CreatePersonaDto, ['code', 'voiceId', 'speakingRate', 'turnWaitLevel'] as const),
  { skipNullProperties: false },
) {
  @ApiProperty({
    description: '확인한 headVersion.version. HEAD가 달라지면 409.',
    minimum: 1,
    maximum: 2147483647,
    example: 1,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion!: number;

  @ApiProperty({
    description:
      '조회한 draft.draftRevision. 초안이 없으면 반드시 null, 있으면 해당 UUID를 보냅니다. 생략 불가이며 다른 수정·확정 이후의 오래된 값은 409입니다. 인증 토큰이 아닙니다.',
    type: String,
    format: 'uuid',
    nullable: true,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== null)
  @IsUUID('4')
  expectedDraftRevision!: string | null;

  @ApiPropertyOptional({
    description: '생략하면 유지, null이면 AI 기본 음성.',
    type: String,
    nullable: true,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsString()
  @Matches(/\S/)
  voiceId?: string | null;

  @ApiPropertyOptional({
    description: '생략하면 유지, null이면 기본 속도. AI 지원 범위로 검증.',
    type: Number,
    nullable: true,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined && value !== null)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(Number.MIN_VALUE)
  speakingRate?: number | null;

  @ApiPropertyOptional({
    description: '생략하면 유지. AI 지원 목록 안의 값.',
    enum: TURN_WAIT_LEVELS,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(TURN_WAIT_LEVELS)
  turnWaitLevel?: TurnWaitLevel;
}

export class CommitPersonaDraftDto {
  @ApiProperty({ description: '확인한 headVersion.version.', minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion!: number;

  @ApiProperty({ description: '확정할 초안의 draftRevision.', type: String, format: 'uuid' })
  @IsUUID('4')
  expectedDraftRevision!: string;
}

export class PersonaIdDto {
  @ApiProperty({
    description: '페르소나 번호(ai_personas.ai_persona_seq).',
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    example: 1,
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}

export class PersonaListQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '조회 개수.', default: 20, minimum: 1, maximum: 100 })
  declare limit: number;
  @ApiPropertyOptional({ description: '건너뛸 개수.', default: 0, minimum: 0 })
  declare offset: number;
}
