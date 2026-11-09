import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsString, Matches, MaxLength } from 'class-validator';

export class CallIdentityDto {
  @ApiProperty({
    description:
      'OpenAI 수신 이벤트의 통화 ID. 같은 통화의 재요청·주문 전송에 동일한 값 사용.',
    example: 'call_example',
  })
  @IsString()
  @MaxLength(200)
  @Matches(new RegExp('^[^\\s' + String.fromCharCode(0) + ']+$'))
  providerCallId!: string;

  @ApiProperty({
    description:
      '수신 이벤트 created_at(Unix 초)을 변환한 시각. 현재 시각으로 바꾸지 않습니다.',
    format: 'date-time',
    example: '2026-10-29T01:00:00Z',
  })
  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  incomingAt!: string;
}
