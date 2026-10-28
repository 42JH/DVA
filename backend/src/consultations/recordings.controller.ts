import { Controller, Get, Param } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { RecordingIdParamsDto, PlaybackResponseDto } from './dto/playback.dto';
import { RecordingPlaybackService } from './recording-playback.service';

@ApiTags('Recordings')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('recordings')
export class RecordingsController {
  constructor(private readonly playback: RecordingPlaybackService) {}

  @Get(':id/url')
  @ApiOperation({
    summary: '녹취 재생 URL 발급',
    description:
      '관리자 세션과 저장된 녹취를 확인한 뒤 최대 5분간 유효한 S3 재생 URL을 발급합니다. 통화 상세에서 받은 recordingSeq를 사용하며 만료 후 재발급합니다.',
  })
  @ApiOkResponse({ description: '임시 재생 URL과 만료 시각.', type: PlaybackResponseDto })
  @ApiResponse({ status: 400, description: '녹취 번호 형식 오류.', type: ErrorResponseDto })
  @ApiResponse({ status: 401, description: '관리자 세션이 없거나 만료됨.', type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: '관리자 업무 접근 권한 없음.', type: ErrorResponseDto })
  @ApiResponse({
    status: 404,
    description: '녹취 DB 기록 또는 S3 파일이 없음.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: 'S3 설정·권한·연결 또는 URL 서명 실패.',
    type: ErrorResponseDto,
  })
  create(@Param() params: RecordingIdParamsDto) {
    return this.playback.create(params.id);
  }
}
