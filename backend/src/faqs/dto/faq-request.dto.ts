import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { FAQ_CATEGORIES, FaqCategory } from '../faq-categories';

export class CreateFaqDto {
  @ApiProperty({ enum: FAQ_CATEGORIES, description: 'FAQ 분류. 전체는 저장하지 않습니다.' })
  @IsIn(FAQ_CATEGORIES)
  category!: FaqCategory;

  @ApiProperty({
    description: 'FAQ 질문. 공백만 입력 불가.',
    maxLength: 1000,
    example: '택배 접수는 어떻게 하나요?',
  })
  @IsString()
  @Matches(/\S/u)
  @Matches(/^[^\0]*$/u)
  @MaxLength(1000)
  question!: string;

  @ApiProperty({
    description: 'FAQ 답변. 여러 문단·목록·Markdown 표를 보존합니다.',
    maxLength: 20000,
    example: '전화 상담으로 접수를 요청할 수 있습니다.',
  })
  @IsString()
  @Matches(/\S/u)
  @Matches(/^[^\0]*$/u)
  @MaxLength(20000)
  answer!: string;
}

export class UpdateFaqDto extends CreateFaqDto {}

export class CreateFaqsDto {
  @ApiProperty({ type: [CreateFaqDto], minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsObject({ each: true })
  @ValidateNested({ each: true })
  @Type(() => CreateFaqDto)
  items!: CreateFaqDto[];
}

export class DeleteFaqsDto {
  @ApiProperty({ type: [Number], minItems: 1, maxItems: 100, example: [123, 124] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  faqEntrySeqs!: number[];
}

export class FaqQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: '질문·답변 부분 검색. 대소문자 구분 없음. %·_는 일반 문자.',
    maxLength: 200,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @Matches(/^[^\0]*$/u)
  @MaxLength(200)
  q?: string;
}

export class AdminFaqQueryDto extends FaqQueryDto {
  @ApiPropertyOptional({
    enum: FAQ_CATEGORIES,
    description: '분류별 조회. 전체는 파라미터를 생략합니다.',
  })
  @IsOptional()
  @IsIn(FAQ_CATEGORIES)
  category?: FaqCategory;
}

export class AiFaqQueryDto extends FaqQueryDto {
  @ApiPropertyOptional({
    type: String,
    description: '조회할 FAQ 번호 1~100개를 쉼표로 구분. 생략하면 전체 목록.',
    example: '123,124',
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+(,\d+)*$/.test(value) ? value.split(',').map(Number) : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(2147483647, { each: true })
  faqEntrySeqs?: number[];
}

export class FaqIdParamsDto {
  @ApiProperty({ description: 'FAQ 번호.', minimum: 1, maximum: 2147483647, type: Number })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}
