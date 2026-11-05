import { MOBILE_PHONE_PATTERN } from '../../common/mobile-phone';
import { ApiProperty, ApiPropertyOptional, OmitType, getSchemaPath } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsObject,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  MEMBER_ROLES,
  MEMBER_STATUSES,
  type MemberRole,
  type MemberStatus,
} from '../members.types';
import { CustomerAddressDto } from '../../customers/dto/customer-address.dto';

export class MemberIdParamsDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '경로에 따라 organizationSeq 또는 membershipSeq',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
export class CreateMemberDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: '같은 기업의 부서 번호. 생략 또는 null이면 부서 없음.',
    minimum: 1,
    maximum: 2147483647,
  })
  @ValidateIf((_o, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  departmentSeq?: number | null;
  @ApiProperty({
    description: '기업 내 고유 사번. 선행 0과 대소문자를 보존하며 등록 후 변경 불가.',
  })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @Matches(new RegExp(`^[^${String.fromCharCode(0)}]+$`))
  employeeNo!: string;

  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  customerSeq!: number;

  @ApiProperty({
    enum: MEMBER_ROLES,
    description: 'MEMBER 일반 구성원 / ORG_ADMIN 대표자 표시. 관리자 웹 권한을 부여하지 않습니다.',
  })
  @IsIn(MEMBER_ROLES)
  role!: MemberRole;
}
export class InlineMemberDto extends OmitType(CreateMemberDto, ['customerSeq', 'role'] as const) {
  @ApiPropertyOptional({
    type: CustomerAddressDto,
    nullable: true,
    description:
      '고객의 내 주소. 고객·기업 소속과 함께 저장합니다. 생략 시 기존 주소 유지(신규는 null), null로 삭제, 객체는 전체 교체. 도로명·지번·동·우편번호 필수, 상세주소 선택.',
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerAddressDto)
  address?: CustomerAddressDto | null;

  @ApiPropertyOptional({
    enum: MEMBER_ROLES,
    description:
      '대표자 표시. 신규 생략은 MEMBER, 기존 직원 갱신에서 생략하면 현재 역할을 유지합니다. 관리자 웹 권한과 무관합니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_ROLES)
  role?: MemberRole;

  @ApiProperty({ description: '직원 이름. 앞뒤 공백 제거, 빈 값 불가.' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @Matches(new RegExp(`^[^${String.fromCharCode(0)}]+$`))
  name!: string;
  @ApiProperty({
    description: '휴대전화 번호 11자리 문자열. 선행 0 유지.',
    pattern: MOBILE_PHONE_PATTERN.source,
  })
  @IsString()
  @Matches(MOBILE_PHONE_PATTERN)
  phoneNumber!: string;
}

export class CreateMembersDto {
  @ApiProperty({
    type: 'array',
    minItems: 1,
    maxItems: 1000,
    items: {
      oneOf: [{ $ref: getSchemaPath(CreateMemberDto) }, { $ref: getSchemaPath(InlineMemberDto) }],
    },
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsObject({ each: true })
  items!: unknown[];
}

export class UpdateMemberDto {
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: '같은 기업 내 이동할 부서 번호. 생략 시 유지, null로 부서 연결 해제.',
    minimum: 1,
    maximum: 2147483647,
  })
  @ValidateIf((_o, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  departmentSeq?: number | null;
  @ApiPropertyOptional({ enum: MEMBER_ROLES, description: '대표자 여부 표시. 별도 권한 없음.' })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_ROLES)
  role?: MemberRole;

  @ApiPropertyOptional({ enum: MEMBER_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_STATUSES)
  status?: MemberStatus;
}
export class ListMembersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MEMBER_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(MEMBER_STATUSES)
  status?: MemberStatus;
}
