import { MOBILE_PHONE_PATTERN } from '../../common/mobile-phone';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsObject,
  IsString,
  Matches,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CallIdentityDto } from '../../consultations/dto/call-identity.dto';

export class CallerContextRequestDto {
  @ApiProperty({
    description:
      '국내 표기로 정규화한 발신 휴대전화 번호. 선행 0을 보존한 숫자 문자열 11자리.',
    pattern: MOBILE_PHONE_PATTERN.source,
    example: '01012345678',
  })
  @IsString()
  @Matches(MOBILE_PHONE_PATTERN)
  phoneNumber!: string;

  @ApiPropertyOptional({
    type: () => CallIdentityDto,
    description:
      'AI가 실제 상담 업무 의도를 확인한 뒤 전달. 통화를 생성·재사용하고 callSessionSeq를 반환합니다. 최초 고객 확인은 call 없이 조회하며 통화를 저장하지 않습니다. providerCallId·incomingAt은 최초 수신 이벤트 값을 유지합니다.',
  })
  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CallIdentityDto)
  call?: CallIdentityDto;
}
