import { ApiProperty } from '@nestjs/swagger';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_RESULTS,
  AuditActorType,
  AuditLog,
  AuditResult,
} from '../audit.types';

export class AuditResponseDto implements AuditLog {
  @ApiProperty()
  auditLogSeq!: number;

  @ApiProperty({ enum: AUDIT_ACTOR_TYPES })
  actorType!: AuditActorType;

  @ApiProperty({ type: Number, nullable: true })
  actorSeq!: number | null;

  @ApiProperty({ example: 'ADMIN_ACCESS_CHANGED' })
  action!: string;

  @ApiProperty({ example: 'ADMIN_USER' })
  targetType!: string;

  @ApiProperty({ type: Number, nullable: true })
  targetSeq!: number | null;

  @ApiProperty({ type: String, format: 'uuid' })
  requestId!: string;

  @ApiProperty({ enum: AUDIT_RESULTS })
  result!: AuditResult;

  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    description: '현재 공개 필드가 정의되지 않아 빈 객체로 반환합니다.',
    example: {},
  })
  metadata!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  occurredAt!: Date;
}

export class AuditListResponseDto {
  @ApiProperty({ type: [AuditResponseDto] })
  data!: AuditResponseDto[];

  @ApiProperty()
  hasNext!: boolean;
}
