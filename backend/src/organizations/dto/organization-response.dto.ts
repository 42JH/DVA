import { ApiProperty } from '@nestjs/swagger';
import { ORGANIZATION_STATUSES, OrganizationStatus } from '../organizations.types';

export class CreatedOrganizationDto {
  @ApiProperty({ type: Number, minimum: 1 })
  organizationSeq!: number;
}

export class OrganizationResponseDto extends CreatedOrganizationDto {
  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ORGANIZATION_STATUSES })
  status!: OrganizationStatus;
}
