import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class CreateFaqDto {
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

export class UpdateFaqDto extends PartialType(CreateFaqDto, { skipNullProperties: false }) {}

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
