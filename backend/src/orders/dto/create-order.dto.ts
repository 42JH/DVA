import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const present = (_object: unknown, value: unknown) => value !== undefined;

export class OrderAddressPatchDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]+$/)
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

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: -90, maximum: 90 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: -180, maximum: 180 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number | null;
}

export class OriginPinDto {
  @ApiProperty({ enum: ['PERSONAL', 'COMPANY'] })
  @IsIn(['PERSONAL', 'COMPANY'])
  scope!: 'PERSONAL' | 'COMPANY';

  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  pinSeq!: number;
}

export class ParcelInputDto {
  @ApiPropertyOptional({ type: () => OrderAddressPatchDto })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressPatchDto)
  origin?: OrderAddressPatchDto;

  @ApiPropertyOptional({ type: () => OrderAddressPatchDto })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressPatchDto)
  destination?: OrderAddressPatchDto;

  @ApiPropertyOptional({ type: () => OriginPinDto, nullable: true })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OriginPinDto)
  originPin?: OriginPinDto | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  documentCount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  smallBoxCount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  mediumBoxCount?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 2147483647 })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  bigBoxCount?: number;

  @ApiPropertyOptional()
  @ValidateIf(present)
  @IsString()
  otherItemDescription?: string;

  @ApiPropertyOptional()
  @ValidateIf(present)
  @IsString()
  clientComment?: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  itemPrice?: number | null;
}

export class CreateOrderDto {
  @ApiProperty({ minimum: 1, maximum: 2147483647 })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  customerSeq!: number;

  @ApiPropertyOptional({
    enum: ['cat', 'billing', 'credit', 'groupBilling'],
    description: '생략 시 credit으로 저장하며 최종 접수 전 고객 선택과 결제 자격을 재확인합니다.',
  })
  @ValidateIf(present)
  @IsIn(['cat', 'billing', 'credit', 'groupBilling'])
  paymentMethodType?: 'cat' | 'billing' | 'credit' | 'groupBilling';

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  pickupRequestedAt?: string | null;

  @ApiPropertyOptional({ type: () => ParcelInputDto, isArray: true })
  @ValidateIf(present)
  @IsArray()
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ParcelInputDto)
  parcels?: ParcelInputDto[];
}
