import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import { ORGANIZATION_STATUSES, type OrganizationStatus } from '../organizations.types';

export class UpdateOrganizationDto {
  @ApiPropertyOptional({ description: '기업 전체 월결제 자격. 생략 시 유지.' })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  monthlyBillingEnabled?: boolean;
  @ApiPropertyOptional({
    description: '앞뒤 공백을 제거한 기업명. null과 빈 문자열은 허용하지 않습니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ enum: ORGANIZATION_STATUSES })
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(ORGANIZATION_STATUSES)
  status?: OrganizationStatus;
}
