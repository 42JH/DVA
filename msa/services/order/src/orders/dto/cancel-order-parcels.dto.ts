import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';

export class CancelOrderParcelsDto {
  @ApiProperty({
    description:
      '같은 주문에서 취소할 order_parcels.order_parcel_seq 목록. 한 개면 단건 취소. 중복 불가.',
    type: 'array',
    items: { type: 'integer', minimum: 1, maximum: 2147483647 },
    minItems: 1,
    uniqueItems: true,
    example: [101, 102],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  orderParcelSeqs!: number[];
}
