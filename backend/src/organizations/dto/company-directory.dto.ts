import { ApiProperty } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CompanyPinDto } from '../../pins/dto/pin-response.dto';

export class CompanyDirectoryQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description:
      '기업명·부서명·PIN 별칭·수령인·전화번호·주소 검색. 공백으로 구분한 모든 단어가 일치해야 합니다.',
    example: '예시기업 물류센터',
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : value,
  )
  @IsString()
  @IsNotEmpty()
  q!: string;
}

export class CompanyDirectoryEntryDto extends CompanyPinDto {
  @ApiProperty({ description: '공식 배송지 PIN이 소속된 기업명.' })
  organizationName!: string;
}

export class CompanyDirectoryEnvelopeDto {
  @ApiProperty({ type: [CompanyDirectoryEntryDto] }) data!: CompanyDirectoryEntryDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
