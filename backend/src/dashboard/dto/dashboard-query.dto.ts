import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const DASHBOARD_CUSTOMER_TYPES = ['ALL', 'NEW', 'EXISTING'] as const;
export type DashboardCustomerType = (typeof DASHBOARD_CUSTOMER_TYPES)[number];

export class DashboardQueryDto {
  @ApiPropertyOptional({
    enum: DASHBOARD_CUSTOMER_TYPES,
    default: 'ALL',
    description:
      '통화 시작 시 AI가 판정한 고객 구분. ALL에는 미분류도 포함. 날짜 조건은 받지 않습니다.',
  })
  @IsIn(DASHBOARD_CUSTOMER_TYPES)
  customerType: DashboardCustomerType = 'ALL';
}
