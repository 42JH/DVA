import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export class CollectedUnansweredQuestionDto {
  @ApiProperty({
    minimum: 1,
    description: '생성하거나 동일 재전송으로 확인한 미답변 질문 번호.',
  })
  unansweredQuestionSeq!: number;
}

export class UnansweredQuestionResponseDto {
  @ApiProperty({
    type: CollectedUnansweredQuestionDto,
    description: '후속 처리 이벤트에서 참조할 질문 번호.',
  })
  data!: CollectedUnansweredQuestionDto;

  @ApiProperty({ type: RequestMetaDto, description: '요청 추적 정보.' })
  meta!: RequestMetaDto;
}
