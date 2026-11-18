import { ApiProperty } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class UnansweredQuestionIdDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 2147483647, description: '미답변 질문 번호.' })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
