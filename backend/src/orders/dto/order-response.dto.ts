import { ApiProperty } from '@nestjs/swagger';

export class CreatedOrderDto {
  @ApiProperty({ minimum: 1 })
  orderSeq!: number;

  @ApiProperty({ minimum: 1, description: '상세 저장까지 완료한 실제 주문 버전입니다.' })
  version!: number;
}
