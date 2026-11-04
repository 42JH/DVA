import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { CreateCustomerDto } from '../../customers/dto/customer-request.dto';
import { OrderCallDto } from './order-call.dto';

const present = (_object: unknown, value: unknown) => value !== undefined;

export class OrderAddressPatchDto {
  @ApiPropertyOptional({ description: '발송인 또는 수령인 이름.', type: String, nullable: true })
  @IsOptional()
  @IsString()
  name?: string | null;

  @ApiPropertyOptional({
    description: '연락처. 하이픈 없는 숫자 문자열.',
    example: '01012345678',
    type: String,
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9]+$/)
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

export class OriginPinDto {
  @ApiProperty({
    description: '출발지 주소록 유형. PERSONAL: 개인, COMPANY: 기업.',
    enum: ['PERSONAL', 'COMPANY'],
  })
  @IsIn(['PERSONAL', 'COMPANY'])
  scope!: 'PERSONAL' | 'COMPANY';

  @ApiProperty({
    description: '선택한 주소록 번호(personalPinSeq 또는 companyPinSeq).',
    minimum: 1,
    maximum: 2147483647,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  pinSeq!: number;
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
    description: '물품 가액(원). 생성 시 기본 null, 수정 시 생략하면 유지·null이면 비우기.',
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

export class OrderCustomerDto extends OmitType(CreateCustomerDto, [
  'monthlyBillingEnabled',
  'address',
] as const) {}

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
    enum: ['COMPLETE', 'INCOMPLETE', 'CANCELLED'],
    description:
      'AI 상담 결과. COMPLETE만 디버 접수, INCOMPLETE는 미완료 저장, CANCELLED는 상담 중 취소 저장. call과 함께 전달합니다.',
  })
  @ValidateIf(present)
  @IsIn(['COMPLETE', 'INCOMPLETE', 'CANCELLED'])
  outcome?: 'COMPLETE' | 'INCOMPLETE' | 'CANCELLED';

  @ApiPropertyOptional({
    type: () => OrderCallDto,
    description: 'AI 결과 필수 통화 정보. 기존 통화 번호 없이 세션을 생성·연결합니다.',
  })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => OrderCallDto)
  call?: OrderCallDto;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: '기존 고객 번호. customer와 동시 입력 불가. AI 미완료·취소 결과는 고객 생략 가능.',
  })
  @ValidateIf(
    (input: CreateOrderDto, value: unknown) =>
      value !== undefined ||
      (input.customer === undefined &&
        !(input.call && ['INCOMPLETE', 'CANCELLED'].includes(input.outcome ?? ''))),
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  customerSeq?: number;

  @ApiPropertyOptional({
    type: () => OrderCustomerDto,
    description:
      '고객 번호를 모를 때 이름·전화번호 입력. 기존 번호는 고객을 연결하고, 미등록 번호는 고객을 생성합니다.',
  })
  @ValidateIf(present)
  @IsObject()
  @ValidateNested()
  @Type(() => OrderCustomerDto)
  customer?: OrderCustomerDto;

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

  @ApiPropertyOptional({
    description:
      '주문 상세(출발지·도착지·물품) 목록. 미완료는 생략·빈 배열 가능하며 최종 접수에는 한 건 이상 필요합니다.',
    type: () => ParcelInputDto,
    isArray: true,
  })
  @ValidateIf(present)
  @IsArray()
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ParcelInputDto)
  parcels?: ParcelInputDto[];
}
