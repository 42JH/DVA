import { ApiProperty } from '@nestjs/swagger';
import { ORGANIZATION_STATUSES, type OrganizationStatus } from '../organizations.types';

export class CreatedOrganizationDto {
  @ApiProperty({ type: Number, minimum: 1 })
  organizationSeq!: number;
}

export class OrganizationResponseDto extends CreatedOrganizationDto {
  @ApiProperty({ description: '현재 사용 가능한 기업 카드 등록 여부.' })
  groupCardRegistered!: boolean;
  @ApiProperty({ description: '기업 전체 월결제 사용 자격.' }) monthlyBillingEnabled!: boolean;
  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ORGANIZATION_STATUSES })
  status!: OrganizationStatus;
}

export class OrganizationSummaryDto extends OrganizationResponseDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '현재 ACTIVE 구성원 수. 부서 없는 사원과 대표자도 포함합니다.',
  })
  memberCount!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: '기업 등록 시각(ISO 8601). 과거 생성 감사 이력이 없으면 null입니다.',
  })
  createdAt!: string | null;
}
