import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

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
export class DepartmentDto {
  @ApiProperty() departmentSeq!: number;
  @ApiProperty() organizationSeq!: number;
  @ApiProperty() name!: string;
  @ApiProperty() groupBillingEnabled!: boolean;
}
