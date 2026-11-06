import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  ValidateNested,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { MOBILE_PHONE_PATTERN } from '../../common/mobile-phone';
import { CUSTOMER_STATUSES, CustomerStatus } from '../customers.types';

import { CustomerAddressDto } from './customer-address.dto';

const trim = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateCustomerDto {
  @ApiProperty({
    type: CustomerAddressDto,
    description:
      '등록 시 필수인 고객의 내 주소. 도로명·지번·동·우편번호 필수, 상세주소는 생략·빈 문자열 허용. PIN과 독립.',
  })
  @IsDefined()
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerAddressDto)
  address!: CustomerAddressDto;
  @ApiPropertyOptional({
    description: '개인 월결제 자격. 관리자만 true로 설정 가능. 미입력 시 false.',
    default: false,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  monthlyBillingEnabled?: boolean;
  @ApiProperty({ description: '이름. 앞뒤 공백 제거, 빈 이름 불가.' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiProperty({
    description: '선행 0을 보존한 휴대전화 번호 11자리 문자열. 하이픈·공백·국가번호 + 불가.',
    pattern: MOBILE_PHONE_PATTERN.source,
  })
  @IsString()
  @Matches(MOBILE_PHONE_PATTERN)
  phoneNumber!: string;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({
    type: CustomerAddressDto,
    nullable: true,
    description:
      '고객의 내 주소. PIN과 독립. 생략 시 유지(생성 시 null), null로 삭제, 객체는 전체 교체.',
  })
  @ValidateIf((_o, value) => value !== undefined && value !== null)
  @IsObject()
  @ValidateNested()
  @Type(() => CustomerAddressDto)
  address?: CustomerAddressDto | null;
  @ApiPropertyOptional({ description: '개인 월결제 자격. 관리자만 변경 가능. 생략 시 유지.' })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  monthlyBillingEnabled?: boolean;
  @ApiPropertyOptional({ description: '이름. null과 빈 이름 불가.' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({
    enum: CUSTOMER_STATUSES,
    description: 'ACTIVE 관리자 전용. WITHDRAWN에서 ACTIVE로 복구는 지원하지 않습니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(CUSTOMER_STATUSES)
  status?: CustomerStatus;
}

export class ListCustomersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: '이름 부분 검색. 앞뒤 공백 제거.' })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(trim)
  @IsString()
  q?: string;

  @ApiPropertyOptional({
    description: '휴대전화 번호 11자리 정확히 일치 검색.',
    pattern: MOBILE_PHONE_PATTERN.source,
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Matches(MOBILE_PHONE_PATTERN)
  phoneNumber?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(CUSTOMER_STATUSES)
  status?: CustomerStatus;
}

export class CustomerIdParamsDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647, description: 'customerSeq' })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
