import { ApiProperty, OmitType } from '@nestjs/swagger';
import { OrderResultDto } from './order-response.dto';

export class NoOrderResultDto extends OmitType(OrderResultDto, [
  'orderSeq',
  'version',
  'status',
] as const) {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '주문 정보가 없어 생성하지 않음. 항상 null.',
  })
  orderSeq: null = null;

  @ApiProperty({ type: Number, nullable: true, description: '주문이 없어 버전도 없음. 항상 null.' })
  version: null = null;

  @ApiProperty({
    enum: ['NO_ORDER'],
    description: '통화 결과 수신 완료. 주문·결제·디버 접수를 생성하지 않음.',
  })
  status = 'NO_ORDER' as const;

  paymentRequest: null = null;
  paymentDueAt: null = null;
  totalAmount: null = null;
  parcelNo: null = null;

  constructor(callSessionSeq: number) {
    super();
    this.callSessionSeq = callSessionSeq;
  }
}
