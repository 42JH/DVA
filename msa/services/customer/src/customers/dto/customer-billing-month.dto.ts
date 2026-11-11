import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export class CustomerBillingMonthDto {
  @ApiProperty() customerSeq!: number;
  @ApiProperty({ example: '2026-11' }) month!: string;
  @ApiProperty({ description: '개인 월결제 사용액(원).', minimum: 0 }) monthlyAmount!: number;
}

export class CustomerBillingMonthEnvelopeDto {
  @ApiProperty({ type: CustomerBillingMonthDto }) data!: CustomerBillingMonthDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
