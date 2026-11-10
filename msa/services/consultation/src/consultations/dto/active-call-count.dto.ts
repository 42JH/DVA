import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export class ActiveCallCountDto {
  @ApiProperty({
    type: Number,
    minimum: 0,
    example: 37,
    description:
      '기능 도입 후 등록되어 PBX·AI 분석 어느 쪽에도 종료 시각이 없는 통화 수.',
  })
  activeCallCount!: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'DB에서 현재 건수를 관측한 시각.',
  })
  observedAt!: string;
}

export class ActiveCallCountResponseDto {
  @ApiProperty({ type: ActiveCallCountDto })
  data!: ActiveCallCountDto;

  @ApiProperty({ type: RequestMetaDto })
  meta!: RequestMetaDto;
}
