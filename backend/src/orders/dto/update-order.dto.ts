import { Type } from 'class-transformer';
import { IsArray, IsInt, IsObject, Max, Min, ValidateIf, ValidateNested } from 'class-validator';
import { ApiProperty, ApiPropertyOptional, PickType } from '@nestjs/swagger';
import { CreateOrderDto, ParcelInputDto } from './create-order.dto';

export class ParcelChangeDto extends ParcelInputDto {
  @ApiPropertyOptional({
    description: '수정할 상세 번호. 생략하면 마지막 순번에 새 상세를 추가합니다.',
    minimum: 1,
    maximum: 2147483647,
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(2147483647)
  orderParcelSeq?: number;
}

export class UpdateOrderDto extends PickType(CreateOrderDto, [
  'paymentMethodType',
  'pickupRequestedAt',
] as const) {
  @ApiProperty({
    description: '상세 조회 또는 직전 저장 응답의 version. 일치하지 않으면 409.',
    minimum: 1,
    maximum: 2147483647,
    example: 4,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedVersion!: number;

  @ApiPropertyOptional({
    description:
      'credit: 공통 정산, groupBilling: 기업 그룹카드, billing: 개인카드. 생략하면 유지하며 최종 접수 시 자격을 검증합니다.',
    enum: ['billing', 'credit', 'groupBilling'],
  })
  paymentMethodType?: CreateOrderDto['paymentMethodType'];

  @ApiPropertyOptional({
    description: '수거 요청 시각. 생략하면 유지, null이면 비우기. 시간대 필수.',
    type: String,
    format: 'date-time',
    nullable: true,
    example: '2026-10-28T10:00:00+09:00',
  })
  pickupRequestedAt?: string | null;

  @ApiPropertyOptional({
    description:
      '수정·추가할 상세. 각 상세에 변경값이 필요합니다. 생략한 상세·필드는 유지하며 주소도 부분 병합합니다.',
    type: [ParcelChangeDto],
  })
  @ValidateIf((_object: unknown, value: unknown) => value !== undefined)
  @IsArray()
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ParcelChangeDto)
  parcels?: ParcelChangeDto[];
}

export class UpdatedOrderDto {
  @ApiProperty({
    description: '저장 후 실제 주문 버전. 상세 수에 따라 증가하므로 +1로 추정하지 않습니다.',
    minimum: 1,
  })
  version!: number;
}
