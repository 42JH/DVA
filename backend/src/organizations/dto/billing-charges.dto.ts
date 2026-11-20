import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { BILLING_MONTH_PATTERN } from './billing-month.dto';

export class BillingChargesQueryDto extends PaginationQueryDto {
  @ApiProperty({ example: '2026-11', pattern: BILLING_MONTH_PATTERN.source })
  @IsString()
  @Matches(BILLING_MONTH_PATTERN)
  month!: string;

  @ApiPropertyOptional({ description: '발송인·수령인 이름 또는 주문번호 일부', maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\u0000]*$/u)
  q?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100, type: Number })
  override limit = 50;
}

class BillingChargePartyDto {
  @ApiProperty({ type: String, nullable: true }) name!: string | null;
  @ApiProperty({ type: String, nullable: true }) phoneNumber!: string | null;
  @ApiProperty({ type: String, nullable: true }) address!: string | null;
}

class BillingChargeSenderDto extends BillingChargePartyDto {
  @ApiProperty({ type: String, nullable: true }) departmentName!: string | null;
}

class BillingChargeItemsDto {
  @ApiProperty() document!: number;
  @ApiProperty() small!: number;
  @ApiProperty() medium!: number;
  @ApiProperty() big!: number;
  @ApiProperty({ type: String, nullable: true }) other!: string | null;
}

class BillingChargeParcelDto {
  @ApiProperty() cancelled!: boolean;
  @ApiProperty({ type: BillingChargePartyDto }) recipient!: BillingChargePartyDto;
  @ApiProperty({ type: BillingChargeItemsDto }) items!: BillingChargeItemsDto;
}

export class BillingChargeDto {
  @ApiProperty() orderSeq!: number;
  @ApiProperty({ type: String, format: 'date-time' }) paidAt!: string;
  @ApiProperty({ minimum: 0 }) amount!: number;
  @ApiProperty() orderCancelled!: boolean;
  @ApiProperty({ type: BillingChargeSenderDto }) sender!: BillingChargeSenderDto;
  @ApiProperty({ type: [BillingChargeParcelDto] }) parcels!: BillingChargeParcelDto[];
}

export class BillingChargesEnvelopeDto {
  @ApiProperty({ type: [BillingChargeDto] }) data!: BillingChargeDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({ type: 'integer', minimum: 0 }) total_count!: number;
  @ApiProperty({ type: 'integer', minimum: 0 }) total_amount!: number;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
