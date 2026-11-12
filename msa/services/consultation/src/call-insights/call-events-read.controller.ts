import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { CallIdParamsDto } from '../consultations/dto/call-id-params.dto';
import { CallEventsService } from './call-events.service';
import {
  CallActionListResponseDto,
  CallProcessingResultListResponseDto,
} from './dto/call-event-response.dto';

@ApiTags('Call Insights')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  type: ErrorResponseDto,
  description: '통화 번호 또는 페이지 조건 오류.',
})
@ApiResponse({
  status: 401,
  type: ErrorResponseDto,
  description: '활성 관리자 세션 필요.',
})
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: '접근 권한 없음.',
})
@ApiResponse({ status: 404, type: ErrorResponseDto, description: '통화 없음.' })
@Controller('calls')
export class CallEventsReadController {
  constructor(private readonly events: CallEventsService) {}

  @Get(':id/actions')
  @ApiOperation({
    summary: '통화 AI 동작 조회',
    description:
      'PIN·이전 주문·FAQ 검색, 고객 조회, 저장 등 동작만 반환합니다. 통화 전체 eventOrder 순서, 정수 초 위치, status 없음. 관리자 세션 전용입니다.',
  })
  @ApiOkResponse({ type: CallActionListResponseDto })
  findActions(
    @Param() params: CallIdParamsDto,
    @Query() query: PaginationQueryDto,
  ) {
    return this.events.findActions(params.id, query);
  }

  @Get(':id/processing-results')
  @ApiOperation({
    summary: '통화 처리 결과 조회',
    description:
      '주문·FAQ 답변·미답변 처리 내용을 조회합니다. FAQ는 실제 질문·답변 발화를 연결하고 삭제한 미답변 원문은 반환하지 않습니다. 관리자 세션 전용입니다.',
  })
  @ApiOkResponse({ type: CallProcessingResultListResponseDto })
  findProcessingResults(
    @Param() params: CallIdParamsDto,
    @Query() query: PaginationQueryDto,
  ) {
    return this.events.findProcessingResults(params.id, query);
  }
}
