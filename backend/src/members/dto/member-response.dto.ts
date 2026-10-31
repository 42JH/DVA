import { ApiProperty } from '@nestjs/swagger';
import { CustomerResponseDto } from '../../customers/dto/customer-response.dto';
import { MEMBER_ROLES, MEMBER_STATUSES, MemberRole, MemberStatus } from '../members.types';

export class MembershipResponseDto {
  @ApiProperty() departmentSeq!: number;
  @ApiProperty() membershipSeq!: number;
  @ApiProperty() customerSeq!: number;
  @ApiProperty() organizationSeq!: number;
  @ApiProperty() employeeNo!: string;
  @ApiProperty({
    enum: MEMBER_ROLES,
    description: 'ORG_ADMIN은 대표자 표시이며 별도 권한을 부여하지 않습니다.',
  })
  role!: MemberRole;
  @ApiProperty({ enum: MEMBER_STATUSES }) status!: MemberStatus;
}
export class MemberViewDto {
  @ApiProperty({ type: MembershipResponseDto }) membership!: MembershipResponseDto;
  @ApiProperty({ type: CustomerResponseDto }) customer!: CustomerResponseDto;
}
export class MembersEnvelopeDto {
  @ApiProperty({ type: [MemberViewDto] }) data!: MemberViewDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
