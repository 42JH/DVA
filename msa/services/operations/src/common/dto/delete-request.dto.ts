import { applyDecorators } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsInt, Max, Min } from 'class-validator';

function DeleteIds() {
  return applyDecorators(
    ApiProperty({
      type: [Number],
      minItems: 1,
      maxItems: 100,
      description: '삭제 대상 번호. 단건도 배열로 전달하며 중복은 허용하지 않습니다.',
    }),
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(100),
    ArrayUnique(),
    IsInt({ each: true }),
    Min(1, { each: true }),
    Max(2147483647, { each: true }),
  );
}

export class DeleteAdminsDto {
  @DeleteIds() adminUserSeqs!: number[];
}
