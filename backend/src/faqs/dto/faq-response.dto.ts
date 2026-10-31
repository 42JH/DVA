import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { FAQ_CATEGORIES, FaqCategory } from '../faq-categories';

export class AgentFaqDto {
  @ApiProperty({ description: 'FAQ 번호.', minimum: 1 })
  faqEntrySeq!: number;
  @ApiProperty({ description: '질문.' })
  question!: string;
  @ApiProperty({ description: '답변. 문단·목록·표를 포함할 수 있습니다.' })
  answer!: string;
  @ApiProperty({ description: '마지막 수정 시각.', format: 'date-time' })
  updatedAt!: string;
}

export class FaqDto extends AgentFaqDto {
  @ApiProperty({
    enum: FAQ_CATEGORIES,
    description: '관리자 FAQ 분류. AI 원본 응답에는 포함하지 않습니다.',
  })
  category!: FaqCategory;

  @ApiProperty({ description: '마지막 수정 관리자. 요청 세션에서 결정합니다.', minimum: 1 })
  updatedByAdminUserSeq!: number;
  @ApiProperty({ description: '생성 시각.', format: 'date-time' })
  createdAt!: string;
}
export class FaqListResponseDto {
  @ApiProperty({ type: [FaqDto] }) data!: FaqDto[];
  @ApiProperty() hasNext!: boolean;
}
export class AgentFaqListResponseDto {
  @ApiProperty({ type: [AgentFaqDto] }) data!: AgentFaqDto[];
  @ApiProperty() hasNext!: boolean;
}
export class FaqResponseDto {
  @ApiProperty({ type: FaqDto }) data!: FaqDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class AgentFaqResponseDto {
  @ApiProperty({ type: AgentFaqDto }) data!: AgentFaqDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
