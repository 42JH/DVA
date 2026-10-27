import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

// 상담 종료 스냅샷은 미수집 값과 형식상 잘못 수집된 문자열도 보존한다.
export class OrderAddressDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  name?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  phoneNumber?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  roadAddress?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  jibunAddress?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  detailAddress?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  dongName?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  postalCode?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsNumber()
  latitude?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsNumber()
  longitude?: number | null;
}

export class ParcelInputDto {
  @ApiPropertyOptional({ type: () => OrderAddressDto, nullable: true })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressDto)
  origin?: OrderAddressDto | null;
  @ApiPropertyOptional({ type: () => OrderAddressDto, nullable: true })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressDto)
  destination?: OrderAddressDto | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  documentCount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  smallBoxCount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  mediumBoxCount?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  bigBoxCount?: number | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  otherItemDescription?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  clientComment?: string | null;
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: '전달 시 고정 요금 3500이어야 합니다.',
  })
  @IsOptional()
  @IsInt()
  notifiedPrice?: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  itemPrice?: number | null;
}

export class OrderInputDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '검증 시 필수: cat/billing/credit/groupBilling. 임의 기본값을 채우지 않습니다.',
  })
  @IsOptional()
  @IsString()
  paymentMethodType?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '타임존이 있는 ISO 8601 시각. 최종 검증에서는 현재 이후여야 합니다.',
  })
  @IsOptional()
  @IsString()
  pickupRequestedAt?: string | null;
  @ApiPropertyOptional({ type: () => ParcelInputDto, isArray: true, nullable: true })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ParcelInputDto)
  parcels?: ParcelInputDto[] | null;
}
