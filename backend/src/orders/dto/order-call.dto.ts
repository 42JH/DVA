import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsString, Matches, MaxLength } from 'class-validator';

export class OrderCallDto {
  @ApiProperty({
    description: 'OpenAI 수신 이벤트의 통화 세션 ID. 재전송 시 같은 값.',
    example: 'sess_example',
  })
  @IsString()
  @MaxLength(200)
  @Matches(/^\S+$/)
  providerCallId!: string;

  @ApiProperty({
    description: '수신 이벤트의 발신번호. +82는 국내 0 표기로 정규화.',
    example: '+821012345678',
  })
  @IsString()
  @Matches(/^\+?[0-9]{3,20}$/)
  callerPhoneNumber!: string;

  @ApiProperty({
    description:
      'OpenAI 수신 이벤트 created_at(Unix 초)을 변환한 시각. 서버 수신 시각을 사용하지 않습니다.',
    format: 'date-time',
    example: '2026-10-27T01:00:00Z',
  })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  incomingAt!: string;
}
