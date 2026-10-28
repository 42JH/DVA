import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class TranscriptQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '조회할 발화 구간 수.',
    default: 20,
    minimum: 1,
    maximum: 100,
  })
  declare limit: number;

  @ApiPropertyOptional({ description: '건너뛸 발화 구간 수.', default: 0, minimum: 0 })
  declare offset: number;
}

export class UtteranceDto {
  @ApiProperty({ description: '발화 구간 번호(call_utterances.call_utterance_seq).', example: 21 })
  callUtteranceSeq!: number;

  @ApiProperty({ description: '통화 안에서의 발화 구간 순서.', minimum: 1, example: 1 })
  utteranceOrder!: number;

  @ApiProperty({
    description: '발화자. CUSTOMER 고객, AI 상담 AI.',
    enum: ['CUSTOMER', 'AI'],
    example: 'CUSTOMER',
  })
  speaker!: 'CUSTOMER' | 'AI';

  @ApiProperty({
    description: '저장된 구간의 누적 대화 원문.',
    example: '택배를 보내고 싶어요.\n서울에서 출발해요.',
  })
  utteranceText!: string;

  @ApiProperty({ description: '구간에 마지막으로 반영된 문장 순번.', minimum: 1, example: 2 })
  lastSentenceSeq!: number;

  @ApiProperty({
    description: '발화 구간의 최초 수신 시각. 음성의 정확한 재생 위치가 아닙니다.',
    type: String,
    format: 'date-time',
    example: '2026-10-28T01:00:10.000Z',
  })
  receivedAt!: Date;
}

export class TranscriptResponseDto {
  @ApiProperty({
    description: '발화 순서로 정렬된 대화 구간. 저장된 발화가 없으면 빈 배열.',
    type: [UtteranceDto],
  })
  data!: UtteranceDto[];

  @ApiProperty({ description: '다음 페이지 존재 여부.', example: false })
  hasNext!: boolean;
}
