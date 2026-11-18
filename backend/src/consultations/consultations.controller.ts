import { DeleteCallsDto } from '../common/dto/delete-request.dto';
import { Body } from '@nestjs/common';
import { Controller, Delete, Get, Header, HttpCode, Param, Query, Req, Sse } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ConsultationsService } from './consultations.service';
import { CallQueryDto } from './dto/call-query.dto';
import { CallDetailResponseDto, CallListResponseDto } from './dto/call-response.dto';
import { CallIdParamsDto } from './dto/call-id-params.dto';
import { TranscriptQueryDto, TranscriptResponseDto } from './dto/transcript.dto';
import { ActiveCallCountService } from './active-call-count.service';
import { ActiveCallCountResponseDto } from './dto/active-call-count.dto';
import { AuditOperation } from '../audit/audit-operation';

@ApiTags('Calls')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '조회 조건 또는 통화 번호 형식 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '관리자 세션이 없거나 만료됨.', type: ErrorResponseDto })
@ApiResponse({ status: 403, description: '관리자 업무 접근 권한 없음.', type: ErrorResponseDto })
@Controller('calls')
export class ConsultationsController {
  constructor(
    private readonly consultations: ConsultationsService,
    private readonly activeCalls: ActiveCallCountService,
  ) {}

  @Delete()
  @HttpCode(204)
  @AuditOperation({
    action: 'CALL_DELETED',
    targetType: 'CALL_SESSION',
    target: 'ids',
    idsField: 'callSessionSeqs',
  })
  @ApiOperation({
    summary: '통화 soft delete',
    description:
      '허용 Origin 필수. 통화와 분석·AI 이벤트·STT·녹취를 일반 조회에서 숨깁니다. 실제 폐기는 삭제일부터 5년 후 수행하며 주문은 별도로 유지합니다.',
  })
  @ApiResponse({ status: 204, description: '삭제 처리 완료.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: '없거나 삭제·만료된 통화.' })
  @ApiResponse({
    status: 409,
    type: ErrorResponseDto,
    description: '통화 종료 전 또는 녹취 대기·실패·업로드 중.',
  })
  delete(@Body() input: DeleteCallsDto, @Req() request: AuthRequest) {
    return this.consultations.delete(
      input.callSessionSeqs,
      request.admin.adminUserSeq,
      request.requestId,
    );
  }

  @Get('active-count')
  @ApiOperation({
    summary: '진행 중 통화 수 조회',
    description:
      '기능 도입 후 등록된 통화 중 PBX·AI 분석 어느 쪽에도 종료 시각이 없는 건수를 제공합니다. 과거 미확인 통화·삭제·보관 만료는 제외하며 주문 상태는 집계 기준으로 사용하지 않습니다.',
  })
  @ApiOkResponse({ type: ActiveCallCountResponseDto })
  @ApiResponse({
    status: 503,
    description: '현재 통화 수를 확인할 수 없음.',
    type: ErrorResponseDto,
  })
  activeCount() {
    return this.activeCalls.read();
  }

  @Sse('active-count/stream')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary: '진행 중 통화 수 변경 구독',
    description:
      '관리자 쿠키로 구독하며 최초 현재값과 active-call-count 이벤트를 제공합니다. 5초 heartbeat·세션 재검증, session-expired·stream-error 종료 이벤트를 처리해야 합니다.',
  })
  @ApiOkResponse({
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'event: active-call-count\ndata: {"activeCallCount":37,"observedAt":"2026-11-03T00:00:00.000Z"}\n\n',
        },
      },
    },
  })
  @ApiResponse({ status: 503, description: '초기 구독을 준비할 수 없음.', type: ErrorResponseDto })
  activeCountStream(@Req() request: AuthRequest) {
    return this.activeCalls.stream(request.sessionToken);
  }

  @Get()
  @ApiOperation({
    summary: '통화 목록 조회',
    description:
      '고객 이름·발신번호 검색과 현재 소속 기업·통화 분석 결과·불만 여부·실제 페르소나 버전 필터를 제공합니다. 기업명은 현재 소속 기준이며 소속 변경 시 과거 목록 표시도 바뀝니다. 기간·정렬·표시 시작 시각은 PBX 시작, AI 시작, 수신 이벤트 시각 순으로 사용합니다. 분석 미수신은 analysis=null이며 녹취 업로드 전에도 조회합니다.',
  })
  @ApiOkResponse({
    description: '통화 목록과 다음 페이지 여부, 같은 조회 조건의 전체 건수.',
    type: CallListResponseDto,
  })
  findMany(@Query() query: CallQueryDto) {
    return this.consultations.findMany(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '통화 상세 조회',
    description:
      '고객·통화·저장된 AI 분석과 녹취별 재생 URL을 조회합니다. analysis는 미수신이면 null, 녹취 미수집은 recordings=[]이며 다른 수집 데이터를 숨기지 않습니다. URL은 최대 5분 유효하며 녹취 오류는 개별 playbackError로 반환합니다.',
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
