import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import { APPLY_ERRORS, ApplyError } from '../ai-settings.types';

export class ActivatePersonaDto {
  @ApiProperty({
    description:
      '사용자가 확인한 headVersion.aiPersonaVersionSeq. 요청 시 현재 HEAD와 다르면 409이며 수락 후에는 이후 저장과 무관하게 이 버전으로 고정됩니다.',
    minimum: 1,
    maximum: 2147483647,
    example: 3,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  aiPersonaVersionSeq!: number;

  @ApiProperty({
    description: '페르소나 상세의 latestVersion.version. 동시 편집을 확인합니다.',
    minimum: 1,
    maximum: 2147483647,
    example: 2,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion!: number;
}

export class RuntimeConfigQueryDto {
  @ApiPropertyOptional({
    description: 'ACTIVE는 현재 운영 설정, PENDING은 적용 대상. 미지정은 ACTIVE.',
    enum: ['ACTIVE', 'PENDING'],
    default: 'ACTIVE',
  })
  @IsIn(['ACTIVE', 'PENDING'])
  status: 'ACTIVE' | 'PENDING' = 'ACTIVE';
}

export class PersonaApplyResultDto {
  @ApiProperty({
    description: '실제로 적용을 시도한 전체 버전 식별자.',
    minimum: 1,
    maximum: 2147483647,
    example: 3,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  aiPersonaVersionSeq!: number;

  @ApiProperty({
    description: 'PENDING 조회에서 받은 적용 요청 UUID. 같은 버전의 예전 요청과도 구분합니다.',
    format: 'uuid',
  })
  @IsUUID('4')
  applicationId!: string;

  @ApiProperty({
    description:
      'APPLIED 신규 통화 기본 설정 설치 완료, FAILED 설치 실패. 기존 통화의 버전은 유지하며 알림 수신만으로 APPLIED를 보내면 안 됩니다.',
    enum: ['APPLIED', 'FAILED'],
  })
  @IsIn(['APPLIED', 'FAILED'])
  result!: 'APPLIED' | 'FAILED';

  @ApiPropertyOptional({
    deprecated: true,
    description:
      '기존 AI 연동 호환용 활성 통화 수. 생략 가능하며 적용 판단·저장에 사용하지 않습니다. 전송 시 0 이상 정수여야 합니다. 기존 통화의 버전은 유지해야 합니다.',
    minimum: 0,
    maximum: 2147483647,
    example: 0,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  activeCallCount?: number;

  @ApiPropertyOptional({
    description: 'FAILED에만 필수. 프롬프트 원문·예외 메시지는 보내지 않습니다.',
    enum: APPLY_ERRORS,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsIn(APPLY_ERRORS)
  errorCode?: Exclude<ApplyError, 'AI_UNAVAILABLE'>;
}
