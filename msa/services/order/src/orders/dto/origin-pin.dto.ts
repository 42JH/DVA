import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Min, Max } from 'class-validator';

export class OriginPinDto {
  @ApiProperty({
    description:
      '신규 선택은 PERSONAL만 허용. COMPANY는 과거 주문 조회 및 동일 참조·주소를 유지하는 PATCH 호환용.',
    enum: ['PERSONAL', 'COMPANY'],
  })
  @IsIn(['PERSONAL', 'COMPANY'])
  scope!: 'PERSONAL' | 'COMPANY';

  @ApiProperty({
    description: '개인 주소록 번호. 과거 COMPANY 번호는 기존 주문의 논리 참조로만 보존.',
    minimum: 1,
    maximum: 2147483647,
  })
  @IsInt()
  @Min(1)
  @Max(2147483647)
  pinSeq!: number;
}
