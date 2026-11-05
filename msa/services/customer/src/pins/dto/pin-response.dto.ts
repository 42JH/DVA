import { ApiProperty } from '@nestjs/swagger';
import { RequestMetaDto } from '../../common/dto/api-response.dto';
import { PinAddressInputDto } from './pin-request.dto';

export class PinVersionDto {
  @ApiProperty({
    minimum: 1,
    description: 'DB가 반환한 현재 버전. 수정 거절 조건으로 사용하지 않습니다.',
  })
  version!: number;
}
export class CreatedPersonalPinDto extends PinVersionDto {
  @ApiProperty({ minimum: 1 }) personalPinSeq!: number;
}
export class PersonalPinDto extends CreatedPersonalPinDto {
  @ApiProperty({ minimum: 1 }) customerSeq!: number;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty({ type: PinAddressInputDto }) addressData!: PinAddressInputDto;
}
export class CreatedPersonalPinEnvelopeDto {
  @ApiProperty({ type: CreatedPersonalPinDto }) data!: CreatedPersonalPinDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class PinVersionEnvelopeDto {
  @ApiProperty({ type: PinVersionDto }) data!: PinVersionDto;
  @ApiProperty({ type: RequestMetaDto }) meta!: RequestMetaDto;
}
export class PersonalPinsEnvelopeDto {
  @ApiProperty({ type: [PersonalPinDto] }) data!: PersonalPinDto[];
  @ApiProperty() hasNext!: boolean;
  @ApiProperty({
    type: 'integer',
    minimum: 0,
    description: '검색·필터 후 limit·offset 적용 전 전체 건수.',
  })
  total_count!: number;
}
