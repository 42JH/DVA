import { ApiProperty } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { OrderIdParamsDto } from './order-query.dto';

export class CancelOrderParcelParamsDto extends OrderIdParamsDto {
  @ApiProperty({
    description: '취소할 상세의 order_parcels.order_parcel_seq. 주문 내 순번이 아닙니다.',
    type: Number,
    minimum: 1,
    maximum: 2147483647,
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  orderParcelSeq!: number;
}
