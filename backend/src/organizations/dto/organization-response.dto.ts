import { ApiProperty } from '@nestjs/swagger';
import { ORGANIZATION_STATUSES, OrganizationStatus } from '../organizations.types';

export class CreatedOrganizationDto {
  @ApiProperty({ type: Number, minimum: 1 })
  organizationSeq!: number;
}

export class OrganizationResponseDto extends CreatedOrganizationDto {
  @ApiProperty({ description: '기업 전체 월결제 사용 자격.' }) monthlyBillingEnabled!: boolean;
  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ORGANIZATION_STATUSES })
  status!: OrganizationStatus;
}
