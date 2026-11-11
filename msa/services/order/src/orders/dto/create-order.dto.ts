import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { MOBILE_PHONE_PATTERN } from '../../common/mobile-phone';
import { MAX_ORDER_ITEM_PRICE, MIN_ORDER_ITEM_PRICE } from '../orders.types';
import { OriginPinDto } from './origin-pin.dto';
const present = (_object: unknown, value: unknown) => value !== undefined;

export class OrderAddressPatchDto {
  @ApiPropertyOptional({ description: '발송인 또는 수령인 이름.', type: String, nullable: true })
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiPropertyOptional({
    description: '연락처. 하이픈·공백 없는 휴대전화 번호 11자리 문자열.',
    pattern: MOBILE_PHONE_PATTERN.source,
    example: '01012345678',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(MOBILE_PHONE_PATTERN)
  phoneNumber?: string | null;

  @ApiPropertyOptional({ description: '도로명 주소.', type: String, nullable: true })
  @IsOptional()
  @IsString()
  roadAddress?: string | null;

  @ApiPropertyOptional({ description: '지번 주소.', type: String, nullable: true })
  @IsOptional()
  @IsString()
  jibunAddress?: string | null;

  @ApiPropertyOptional({ description: '상세 주소.', type: String, nullable: true })
  @IsOptional()
  @IsString()
  detailAddress?: string | null;

  @ApiPropertyOptional({ description: '읍·면·동 이름.', type: String, nullable: true })
  @IsOptional()
  @IsString()
  dongName?: string | null;

  @ApiPropertyOptional({
    description: '우편번호. 선행 0을 보존하는 문자열.',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  postalCode?: string | null;
}

export class ParcelInputDto {
  @ApiPropertyOptional({
    description: '이 배송 항목의 배송비(원). 최종 확정 시 필수.',
    minimum: 1,
    maximum: 2147483647,
    nullable: true,
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  notifiedPrice?: number | null;

  @ApiPropertyOptional({
    description: '출발지 정보. 확인한 항목만 입력할 수 있습니다.',
    type: () => OrderAddressPatchDto,
  })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressPatchDto)
  origin?: OrderAddressPatchDto;

  @ApiPropertyOptional({
    description: '도착지 정보. 확인한 항목만 입력할 수 있습니다.',
    type: () => OrderAddressPatchDto,
  })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => OrderAddressPatchDto)
  destination?: OrderAddressPatchDto;

  @ApiPropertyOptional({
    description: '참조할 출발지 주소록. 주소 내용은 origin에 별도로 입력합니다.',
    type: () => OriginPinDto,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OriginPinDto)
  originPin?: OriginPinDto | null;

  @ApiPropertyOptional({
    description: '서류 수량. 생성 시 기본 0, 수정 시 생략하면 유지.',
    minimum: 0,
    maximum: 2147483647,
  })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  documentCount?: number;

  @ApiPropertyOptional({
    description: '소형 박스 수량. 생성 시 기본 0, 수정 시 생략하면 유지.',
    minimum: 0,
    maximum: 2147483647,
  })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  smallBoxCount?: number;

  @ApiPropertyOptional({
    description: '중형 박스 수량. 생성 시 기본 0, 수정 시 생략하면 유지.',
    minimum: 0,
    maximum: 2147483647,
  })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  mediumBoxCount?: number;

  @ApiPropertyOptional({
    description: '대형 박스 수량. 생성 시 기본 0, 수정 시 생략하면 유지.',
    minimum: 0,
    maximum: 2147483647,
  })
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(2147483647)
  bigBoxCount?: number;

  @ApiPropertyOptional({
    description: '기타 물품 설명. 생성 시 기본 빈 문자열, 수정 시 생략하면 유지.',
  })
  @ValidateIf(present)
  @IsString()
  otherItemDescription?: string;

  @ApiPropertyOptional({
    description: '배송 요청 사항. 생성 시 기본 빈 문자열, 수정 시 생략하면 유지.',
  })
  @ValidateIf(present)
  @IsString()
  clientComment?: string;

  @ApiPropertyOptional({
    description:
      '물품 가액(원). 입력 시 1원~1억원 정수. 생성 시 기본 null, 수정 시 생략하면 유지·null이면 비우기. 최종 접수 시 필수.',
    type: Number,
    nullable: true,
    minimum: MIN_ORDER_ITEM_PRICE,
    maximum: MAX_ORDER_ITEM_PRICE,
  })
  @IsOptional()
  @IsInt()
  @Min(MIN_ORDER_ITEM_PRICE)
  @Max(MAX_ORDER_ITEM_PRICE)
  itemPrice?: number | null;
}

export class CreateOrderDto {
  @ApiPropertyOptional({
    description: '취소되지 않은 상세 배송비 합계(원). 최종 확정 시 필수.',
    minimum: 1,
    maximum: 2147483647,
    nullable: true,
  })
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  totalAmount?: number | null;

  @ApiPropertyOptional({
    enum: ['billing', 'credit', 'groupBilling'],
    description:
      'billing: 개인·기업 개인 카드, credit: 월결제, groupBilling: 소속 부서 그룹결제. 생략하면 미정(null)으로 저장하며 최종 접수 전에 선택해야 합니다. 확정 시 자격을 검증합니다.',
  })
  @ValidateIf(present)
  @IsIn(['billing', 'credit', 'groupBilling'])
  paymentMethodType?: 'billing' | 'credit' | 'groupBilling';

  @ApiPropertyOptional({
    description:
      '요청 수거 시각. 결제가 이 시각 이전 또는 같으면 유지합니다. 이후 결제 또는 생략 시 결제 완료 + 1시간을 한국시간 09:00~17:00에 맞추며, 17시 초과는 다음날 09시입니다. 전달 시각에는 별도 영업시간·일수 제한을 두지 않습니다.',
    example: '2026-10-28T10:00:00+09:00',
    type: String,
    format: 'date-time',
    nullable: true,
  })
  @IsOptional()
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  pickupRequestedAt?: string | null;
}
