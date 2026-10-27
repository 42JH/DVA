import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_RESULTS,
  AuditActorType,
  AuditLog,
  AuditResult,
} from '../audit.types';

export class AuditResponseDto implements AuditLog {
  @ApiProperty({ description: '감사 기록 번호.' })
  auditLogSeq!: number;

  @ApiProperty({
    description: '작업 주체. 관리자 식별 시 ADMIN, 그 외 SYSTEM.',
    enum: AUDIT_ACTOR_TYPES,
  })
  actorType!: AuditActorType;

  @ApiProperty({
    description: '작업한 관리자 번호. 식별되지 않으면 null.',
    type: Number,
    nullable: true,
  })
  actorSeq!: number | null;

  @ApiProperty({ description: '수행한 작업 코드.', example: 'ADMIN_ACCESS_CHANGED' })
  action!: string;

  @ApiProperty({ description: '작업 대상 유형.', example: 'ADMIN_USER' })
  targetType!: string;

  @ApiProperty({
    description: '작업 대상 번호. 식별되지 않으면 null.',
    type: Number,
    nullable: true,
  })
  targetSeq!: number | null;

  @ApiProperty({
    description: '요청 추적 ID. 같은 요청에서 발생한 기록을 연결합니다.',
    type: String,
    format: 'uuid',
  })
  requestId!: string;

  @ApiProperty({
    description: '처리 결과. SUCCESS: 성공, DENIED: 접근 거절, FAILED: 실패.',
    enum: AUDIT_RESULTS,
  })
  result!: AuditResult;

  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    description: '추가 정보. 현재는 빈 객체만 반환합니다.',
    example: {},
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({ description: '작업 발생 시각.', type: String, format: 'date-time' })
  occurredAt!: Date;
}

export class AuditListResponseDto {
  @ApiProperty({ description: '감사 기록 목록.', type: [AuditResponseDto] })
  data!: AuditResponseDto[];

  @ApiProperty({ description: '다음 페이지 존재 여부.' })
  hasNext!: boolean;
}

export class AuditDetailResponseDto {
  @ApiProperty({ description: '감사 기록 상세.', type: AuditResponseDto })
  data!: AuditResponseDto;

  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto })
  meta!: RequestMetaDto;
}
