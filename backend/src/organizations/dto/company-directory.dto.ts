import { ApiProperty } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsNotEmpty, IsString } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PinAddressDto } from '../../customers/dto/caller-context.dto';

export class CompanyDirectoryQueryDto extends PaginationQueryDto {
  @ApiProperty({
    description:
      '기업명·부서명·사원 이름·전화번호·현재 주소 검색. 공백으로 구분한 모든 단어가 일치해야 합니다.',
    example: '예시기업 물류센터',
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : value,
  )
  @IsString()
  @IsNotEmpty()
  q!: string;
}

export class CompanyDirectoryEntryDto {
  @ApiProperty({ minimum: 1 }) organizationSeq!: number;
  @ApiProperty({ description: '사원이 소속된 활성 기업명.' })
  organizationName!: string;
  @ApiProperty({ minimum: 1 }) membershipSeq!: number;
  @ApiProperty({ minimum: 1 }) customerSeq!: number;
  @ApiProperty({ type: Number, nullable: true }) departmentSeq!: number | null;
  @ApiProperty({ type: String, nullable: true }) departmentName!: string | null;
  @ApiProperty({ type: PinAddressDto, description: '고객의 현재 이름·전화번호와 기본 주소.' })
  addressData!: PinAddressDto;
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
