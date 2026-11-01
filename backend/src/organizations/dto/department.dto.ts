import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export class CreateDepartmentDto {
  @ApiProperty({ description: '기업 내 고유 부서명.', maxLength: 100 })
  @Transform(({ value }: TransformFnParams) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ description: '그룹결제 사용 가능 여부. 미입력 시 false.', default: false })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  groupBillingEnabled?: boolean;
}
export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto, {
  skipNullProperties: false,
}) {}
export class CreatedDepartmentDto {
  @ApiProperty({ description: '부서 번호.', minimum: 1 }) departmentSeq!: number;
}
export class DepartmentDto extends CreatedDepartmentDto {
  @ApiProperty({ description: '소속 기업 번호.', minimum: 1 }) organizationSeq!: number;
  @ApiProperty({ description: '기업 내 고유 부서명.' }) name!: string;
  @ApiProperty({ description: '해당 부서의 그룹결제 사용 자격.' }) groupBillingEnabled!: boolean;
}
export class DepartmentSummaryDto extends DepartmentDto {
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '해당 부서의 현재 ACTIVE 구성원 수. 대표자도 포함합니다.',
  })
  memberCount!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: '부서 등록 시각(ISO 8601). 과거 생성 감사 이력이 없으면 null입니다.',
  })
  createdAt!: string | null;
}
export class DepartmentEnvelopeDto {
  @ApiProperty({ type: CreatedDepartmentDto }) data!: CreatedDepartmentDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class DepartmentsEnvelopeDto {
  @ApiProperty({ type: [DepartmentSummaryDto] }) data!: DepartmentSummaryDto[];
  @ApiProperty({ description: '다음 페이지 존재 여부.' }) hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
