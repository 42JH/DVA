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

export class FaqQuestionExampleDto {
  @ApiProperty({ description: '고객 질문 사례 번호. 동일 문장도 별도 사례입니다.', minimum: 1 })
  faqQuestionExampleSeq!: number;
  @ApiProperty({ description: '실제 고객 발화 원문.', maxLength: 20000 })
  questionText!: string;
  @ApiProperty({
    description: '실제 FAQ 응대 발생 시각. 최신순·5년 보존 기준.',
    format: 'date-time',
  })
  occurredAt!: string;
}

export class FaqDetailDto extends FaqDto {
  @ApiProperty({
    type: [FaqQuestionExampleDto],
    maxItems: 10,
    description:
      '최근 고객 질문 사례. 발생 시각·사례 번호 내림차순, 없으면 []. 통화 삭제와 독립적으로 최대 5년 보관하며 FAQ 수정·삭제 시 비웁니다.',
  })
  recentQuestions!: FaqQuestionExampleDto[];
}
export class FaqListResponseDto {
  @ApiProperty({ type: [FaqDto] }) data!: FaqDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
export class AgentFaqListResponseDto {
  @ApiProperty({ type: [AgentFaqDto] }) data!: AgentFaqDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
export class FaqResponseDto {
  @ApiProperty({ type: FaqDetailDto }) data!: FaqDetailDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
