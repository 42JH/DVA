import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export class ActiveCallCountDto {
  @ApiProperty({
    type: Number,
    minimum: 0,
    example: 37,
    description: '기능 도입 후 등록되어 PBX 종료가 확인되지 않은 통화 수.',
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
