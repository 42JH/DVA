import { ApiProperty } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class CallIdParamsDto {
  @ApiProperty({
    description:
      '통화 번호(call_sessions.call_session_seq). providerCallId가 아닙니다.',
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    example: 12,
  })
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
