import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_RESULTS,
  type AuditActorType,
  AuditLog,
  type AuditResult,
} from '../audit.types';

export class AuditResponseDto implements AuditLog {
  @ApiProperty({
    enum: ['AI', 'SYSTEM', '운영자'],
    description: '담당자 표시. 실제 운영자 이름·번호는 actorName·actorSeq로 확인.',
  })
  actorLabel!: 'AI' | 'SYSTEM' | '운영자';
  @ApiProperty({ description: '감사 기록 번호.' })
  auditLogSeq!: number;

  @ApiProperty({
    description: '작업 주체. 관리자 ADMIN, AI 업무 호출 AI, 서버 작업·미식별 요청 SYSTEM.',
    enum: AUDIT_ACTOR_TYPES,
  })
  actorType!: AuditActorType;

  @ApiProperty({
    description: '작업한 관리자 번호. 식별되지 않으면 null.',
    type: Number,
    nullable: true,
  })
  actorSeq!: number | null;

  @ApiProperty({
    description:
      '작업 당시 관리자 이름 또는 AI. 과거 미식별 기록은 null. 계정 삭제 후에도 유지됩니다.',
    type: String,
    nullable: true,
  })
  actorName!: string | null;

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
    description: '대상 관리자 당시 이름. ADMIN_USER 이외의 대상 또는 미식별 대상은 null.',
    type: String,
    nullable: true,
  })
  targetAdminName!: string | null;

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
    properties: {
      organizationSeq: { type: 'integer', minimum: 1 },
      organizationName: { type: 'string' },
      departmentSeq: { type: 'integer', minimum: 1 },
      departmentName: { type: 'string' },
      customerSeq: { type: 'integer', minimum: 1 },
      amountBefore: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      amountAfter: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      orderParcelSeqs: {
        type: 'array',
        items: { type: 'integer', minimum: 1, maximum: 2147483647 },
      },
      billingMonth: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
      paymentMethodType: { type: 'string', enum: ['credit', 'groupBilling'] },
      reason: { type: 'string', enum: ['PAYMENT_EXPIRED'] },
    },
    description:
      '허용한 금액·대상 상세·청구 월·결제 방식·자동 만료 사유·삭제 당시 기업/부서/고객 번호와 기업/부서명만 제공합니다.',
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
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}

export class AuditDetailResponseDto {
  @ApiProperty({ description: '감사 기록 상세.', type: AuditResponseDto })
  data!: AuditResponseDto;

  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto })
  meta!: RequestMetaDto;
}
