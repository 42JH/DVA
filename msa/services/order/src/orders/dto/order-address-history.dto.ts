import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsString, Matches, ValidateIf } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { OrderAddressValueDto } from './order-response.dto';

const present = (_object: unknown, value: unknown) => value !== undefined;

export class OrderAddressHistoryQueryDto extends PaginationQueryDto {
  @ApiProperty({ enum: ['ORIGIN', 'DESTINATION'], description: '조회할 주문 주소의 방향.' })
  @IsIn(['ORIGIN', 'DESTINATION'])
  direction!: 'ORIGIN' | 'DESTINATION';

  @ApiPropertyOptional({
    description: '주문 생성 시각의 시작 경계(포함). Z 또는 시간대 오프셋 필수.',
    format: 'date-time',
    example: '2026-10-19T00:00:00+09:00',
  })
  @ValidateIf(present)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  from?: string;

  @ApiPropertyOptional({
    description: '주문 생성 시각의 종료 경계(미포함). from보다 늦어야 합니다.',
    format: 'date-time',
    example: '2026-10-26T00:00:00+09:00',
  })
  @ValidateIf(present)
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  to?: string;

  @ApiPropertyOptional({
    description: '선택한 방향의 이름·연락처·주소 부분 검색. 앞뒤 공백·NFC 정리.',
  })
  @ValidateIf(present)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  q?: string;
}

export class PreviousOrderAddressDto {
  @ApiProperty({ minimum: 1 }) orderSeq!: number;
  @ApiProperty({ minimum: 1 }) orderParcelSeq!: number;
  @ApiProperty({
    format: 'date-time',
    description: '원본 주문 생성 시각. 접수 완료 시각이 아닙니다.',
  })
  createdAt!: string;
  @ApiProperty({
    type: OrderAddressValueDto,
    description: '주문 당시 주소 스냅샷. 원본 PIN 변경과 무관합니다.',
  })
  address!: OrderAddressValueDto;
}

export class OrderAddressHistoryEnvelopeDto {
  @ApiProperty({ type: [PreviousOrderAddressDto] }) data!: PreviousOrderAddressDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
