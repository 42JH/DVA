import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OrderInputDto } from '../../orders/dto/order-input.dto';

export class CreateIncompleteConsultationDto {
  @ApiProperty({ description: '동일 종료 이벤트의 재시도에 재사용하는 식별자' })
  @IsString()
  @Matches(/\S/)
  eventId!: string;

  @ApiProperty({
    description: '기존 통화·녹취 수집에서 사용하는 provider_call_id와 동일한 값. 재통화 시 새 값.',
  })
  @IsString()
  @Matches(/\S/)
  providerCallId!: string;

  @ApiProperty({ format: 'date-time', description: '통화 종료 시점. 타임존 필수.' })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  endedAt!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      '시스템이 실제 보고한 종료 유형만 전달. 불명확하면 null. 원인을 추론하지 않습니다.',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  endType?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '실제 관찰된 시스템 이벤트 코드. 설명·전체 발화·녹취를 넣지 않습니다.',
  })
  @IsOptional()
  @IsString()
  @Matches(/\S/)
  systemEvent?: string | null;

  @ApiProperty({
    type: () => OrderInputDto,
    description: '접수 시도 전 종료 시점의 최종 정보. 누락된 항목을 임의로 채우지 않습니다.',
  })
  @IsObject()
  @ValidateNested()
  @Type(() => OrderInputDto)
  snapshot!: OrderInputDto;
}
