import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ConsultationsService } from './consultations.service';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDetailResponseDto, CallListResponseDto } from './dto/call-response.dto';
import { CallIdParamsDto } from './dto/call-id-params.dto';
import { TranscriptQueryDto, TranscriptResponseDto } from './dto/transcript.dto';

@ApiTags('Calls')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '조회 조건 또는 통화 번호 형식 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '관리자 세션이 없거나 만료됨.', type: ErrorResponseDto })
@ApiResponse({ status: 403, description: '관리자 업무 접근 권한 없음.', type: ErrorResponseDto })
@Controller('calls')
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @Get()
  @ApiOperation({
    summary: '통화 목록 조회',
    description:
      '고객 이름·발신번호 검색과 통화 분석 결과·불만 여부·실제 페르소나 버전 필터를 제공합니다. 기존 주문·PBX 시작 기간·종료 사유·상담원 상태 조건은 유지합니다. 분석 미수신은 analysis=null이며 PBX 시작 시각 최신순입니다.',
  })
  @ApiOkResponse({
    description: '통화 목록과 다음 페이지 여부. 연결 기록이 없으면 handoff는 null.',
    type: CallListResponseDto,
  })
  findMany(@Query() query: CallQueryDto) {
    return this.consultations.findMany(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '통화 상세 조회',
    description:
      '고객·통화·저장된 AI 분석과 녹취별 재생 URL을 조회합니다. analysis는 미수신이면 null이며 실제 사용한 페르소나·불만 근거·정수 초 위치를 제공합니다. URL은 최대 5분 유효하며 녹취 오류는 개별 playbackError로 반환합니다.',
  })
  @ApiOkResponse({
    description: '통화 정보와 재생 URL을 포함한 녹취 목록. 녹취가 없으면 빈 배열.',
    type: CallDetailResponseDto,
  })
  @ApiResponse({ status: 404, description: '해당 통화 기록이 없음.', type: ErrorResponseDto })
  findOne(@Param() params: CallIdParamsDto) {
    return this.consultations.findOne(params.id);
  }

  @Get(':id/transcript')
  @ApiOperation({
    summary: '통화 대화 내용 조회',
    description:
      '저장된 STT 구간을 발화 순서로 조회합니다. 화자·누적 대화·최초 수신 시각을 반환하며, 기록이 없으면 빈 목록입니다. 녹취로부터 STT를 새로 생성하지 않습니다.',
  })
  @ApiOkResponse({
    description: '발화 목록과 다음 페이지 여부. 미수집은 빈 배열이며 무음 통화라는 뜻이 아닙니다.',
    type: TranscriptResponseDto,
  })
  @ApiResponse({ status: 404, description: '해당 통화 기록이 없음.', type: ErrorResponseDto })
  findTranscript(@Param() params: CallIdParamsDto, @Query() query: TranscriptQueryDto) {
    return this.consultations.findTranscript(params.id, query);
  }
}
