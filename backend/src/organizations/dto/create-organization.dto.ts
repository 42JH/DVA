import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsObject,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { InlineMemberDto } from '../../members/dto/member-request.dto';
import { CreateDepartmentDto } from './department.dto';

export class OrganizationMemberDto extends OmitType(InlineMemberDto, ['departmentSeq'] as const) {
  @ApiPropertyOptional({
    description:
      '같은 요청의 departments[].name. 생략·null이면 부서 없음. 앞뒤 공백 제거 후 대소문자를 구분합니다.',
    nullable: true,
    type: String,
    maxLength: 100,
  })
  @Transform(({ value }: TransformFnParams) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  departmentName?: string | null;
}

export class CreateOrganizationDto {
  @ApiPropertyOptional({ description: '기업 전체 월결제 자격. 미입력 시 false.', default: false })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  monthlyBillingEnabled?: boolean;
  @ApiProperty({
    description: '기업명. 앞뒤 공백을 제거하며 같은 이름의 기업도 등록할 수 있습니다.',
  })
  @Transform(({ value }: TransformFnParams) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    type: [CreateDepartmentDto],
    maxItems: 1000,
    description: '함께 생성할 부서. 생략·빈 배열이면 부서 없이 등록합니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @IsObject({ each: true })
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => CreateDepartmentDto)
  departments?: CreateDepartmentDto[];

  @ApiPropertyOptional({
    type: [OrganizationMemberDto],
    maxItems: 1000,
    description:
      '함께 등록할 사원. 기업·부서·고객·소속·성공 감사를 모두 같은 트랜잭션으로 처리합니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @IsObject({ each: true })
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => OrganizationMemberDto)
  members?: OrganizationMemberDto[];
}
