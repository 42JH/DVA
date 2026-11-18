import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, Matches, MaxLength } from 'class-validator';
import {
  FAQ_CATEGORIES,
  type FaqCategory,
} from '@dva/events/faq-conversion.cjs';

export class CreateFaqDto {
  @ApiProperty({
    enum: FAQ_CATEGORIES,
    description: 'FAQ 분류. 전체는 저장하지 않습니다.',
  })
  @IsIn(FAQ_CATEGORIES)
  category!: FaqCategory;

  @ApiProperty({
    description: 'FAQ 질문. 공백만 입력 불가.',
    maxLength: 1000,
    example: '택배 접수는 어떻게 하나요?',
  })
  @IsString()
  @Matches(/\S/u)
  @Matches(new RegExp(`^[^${String.fromCharCode(0)}]*$`, 'u'))
  @MaxLength(1000)
  question!: string;

  @ApiProperty({
    description: 'FAQ 답변. 여러 문단·목록·Markdown 표를 보존합니다.',
    maxLength: 20000,
    example: '전화 상담으로 접수를 요청할 수 있습니다.',
  })
  @IsString()
  @Matches(/\S/u)
  @Matches(new RegExp(`^[^${String.fromCharCode(0)}]*$`, 'u'))
  @MaxLength(20000)
  answer!: string;
}
