import { ApiProperty } from '@nestjs/swagger';
import { Transform, TransformFnParams } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import { RequestMetaDto } from '../../common/dto/api-response.dto';

export class RecordingIdParamsDto {
  @ApiProperty({
    description: '녹취 번호(recordings.recording_seq). 통화 번호와 다릅니다.',
    type: Number,
    minimum: 1,
    maximum: 2147483647,
    example: 7,
  })
  @Transform(({ value }: TransformFnParams) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(1)
  @Max(2147483647)
  id!: number;
}

export class PlaybackDto {
  @ApiProperty({
    description:
      '기존 비공개 S3 녹취의 임시 재생 URL. 최대 5분 유효하며 로그·공유·장기 저장을 피합니다.',
    format: 'uri',
    example:
      'https://dva-d109-storage.s3.ap-northeast-2.amazonaws.com/recordings/example?X-Amz-Algorithm=AWS4-HMAC-SHA256&...',
  })
  url!: string;

  @ApiProperty({
    description:
      'URL 만료 시각. 임시 AWS 자격 증명이 먼저 만료되면 그 시각에 맞춥니다. 만료 후 다시 발급합니다.',
    type: String,
    format: 'date-time',
    example: '2026-10-28T01:09:00.000Z',
  })
  expiresAt!: Date;
}

export class PlaybackResponseDto {
  @ApiProperty({ description: '녹취 재생 URL과 만료 시각.', type: PlaybackDto })
  data!: PlaybackDto;

  @ApiProperty({ description: '요청 추적 정보.', type: RequestMetaDto })
  meta!: RequestMetaDto;
}
