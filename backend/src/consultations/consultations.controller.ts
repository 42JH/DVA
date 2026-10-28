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
      '주문·발신번호·시작 기간·종료 사유·상담원 연결 상태로 조회합니다. 시작 시각 최신순이며 시각 미수집 통화는 뒤에 표시합니다. 고객번호 검색은 미지원입니다.',
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
      '통화·연결 주문 번호·상담원 연결 기록과 녹취 목록을 조회합니다. 대화 내용과 녹취 재생 URL은 각각 별도 조회 API를 사용합니다.',
  })
  @ApiOkResponse({
    description: '통화 정보와 녹취 목록. 미수집 정보는 null 또는 빈 배열.',
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
