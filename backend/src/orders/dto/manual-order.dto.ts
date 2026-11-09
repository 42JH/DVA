import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, IsObject, ValidateNested } from 'class-validator';
import { CreateOrderDto, OrderCustomerDto, ParcelInputDto } from './create-order.dto';
import { OrderResultDto } from './order-response.dto';

export class CreateManualOrderDto extends OmitType(CreateOrderDto, [
  'call',
  'outcome',
  'parcels',
] as const) {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 2147483647,
    description: '기존 활성 고객 번호. customer와 둘 중 하나만 필수.',
  })
  customerSeq?: number;

  @ApiPropertyOptional({
    type: OrderCustomerDto,
    description:
      '고객 번호 대신 이름·전화번호 입력. 기존 활성 번호는 연결하고 미등록 번호는 신규 등록.',
  })
  customer?: OrderCustomerDto;

  @ApiProperty({
    description: '완성된 택배 상세 한 건 이상. AI 접수와 같은 필수값 검증 적용.',
    type: [ParcelInputDto],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => ParcelInputDto)
  parcels!: ParcelInputDto[];
}

export class ManualOrderResultDto extends OmitType(OrderResultDto, ['callSessionSeq'] as const) {
  @ApiProperty({ enum: ['ADMIN'], description: '백엔드가 결정한 관리자 수기 접수 경로.' })
  creationSource!: 'ADMIN';
}
