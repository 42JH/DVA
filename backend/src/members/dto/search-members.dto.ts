import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { ORGANIZATION_STATUSES, OrganizationStatus } from '../../organizations/organizations.types';
import { MEMBER_STATUSES, MemberStatus } from '../members.types';

export class SearchMembersQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description:
      '이름·전화번호·사번·부서명 부분 검색. 정규화 후 1~100자, 모든 단어가 일치해야 합니다.',
    maxLength: 100,
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[^\u0000]+$/u)
  q!: string;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description: '비활성 기업·소속 포함. 삭제·탈퇴는 제외.',
  })
  @Transform(({ value }: TransformFnParams) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeInactive = false;
}

export class MemberSearchEntryDto {
  @ApiProperty() organizationSeq!: number;
  @ApiProperty() organizationName!: string;
  @ApiProperty({ enum: ORGANIZATION_STATUSES }) organizationStatus!: OrganizationStatus;
  @ApiProperty() membershipSeq!: number;
  @ApiProperty({ enum: MEMBER_STATUSES }) membershipStatus!: MemberStatus;
  @ApiProperty() employeeNo!: string;
  @ApiProperty({ type: String, nullable: true }) departmentName!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty() phoneNumber!: string;
}

export class MemberSearchEnvelopeDto {
  @ApiProperty({ type: [MemberSearchEntryDto] }) data!: MemberSearchEntryDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 페이지 적용 전 전체 소속 수.',
  })
  total_count!: number;
}
