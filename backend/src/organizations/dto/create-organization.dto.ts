import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsString, ValidateIf } from 'class-validator';

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
}
