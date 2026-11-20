import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, Matches, ValidateIf } from 'class-validator';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export const BILLING_MONTH_PATTERN = /^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/;

export class BillingMonthQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM. 생략하면 현재 한국 시간 월.', example: '2026-11' })
  @ValidateIf((_o, value) => value !== undefined)
  @IsString()
  @Matches(BILLING_MONTH_PATTERN)
  month?: string;
}
export class BillingMonthDto {
  @ApiProperty() organizationSeq!: number;
  @ApiProperty({
    description: '해당 청구 월에 보존한 기업명. 기업 삭제 후에도 유지.',
    type: String,
    nullable: true,
  })
  organizationName!: string | null;
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ description: '월결제 사용액(원).', minimum: 0 }) monthlyAmount!: number;
  @ApiProperty({ description: '부서 그룹결제 사용액 합계(원).', minimum: 0 })
  groupBillingAmount!: number;
}
export class BillingMonthEnvelopeDto {
  @ApiProperty({ type: BillingMonthDto }) data!: BillingMonthDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
