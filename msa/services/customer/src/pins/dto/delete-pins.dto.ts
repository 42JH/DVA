import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';

export class DeletePinsDto {
  @ApiProperty({
    type: [Number],
    minItems: 1,
    maxItems: 100,
    uniqueItems: true,
    example: [123, 124],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  personalPinSeqs!: number[];
}
