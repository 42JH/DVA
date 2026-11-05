import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class AuditIdParamsDto {
  @ApiProperty({
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    description: '조회할 감사 기록 번호(auditLogSeq).',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
