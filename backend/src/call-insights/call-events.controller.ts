import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest } from '../auth/auth.guard';
import { MVP_AI_ACCESS } from '../auth/mvp-ai-access';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CallIdParamsDto } from '../consultations/dto/call-id-params.dto';
import { CallInsightsGuard } from './call-insights.guard';
import { CallEventsService } from './call-events.service';
import {
  AiActionPayloadDto,
  BusinessResultPayloadDto,
  CreateCallEventsDto,
  UtterancePayloadDto,
} from './dto/create-call-events.dto';

@ApiTags('Call Insights')
@ApiBearerAuth()
@ApiExtraModels(UtterancePayloadDto, AiActionPayloadDto, BusinessResultPayloadDto)
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 413, type: ErrorResponseDto })
@ApiResponse({ status: 422, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('ai/calls')
export class CallEventsController {
  constructor(private readonly events: CallEventsService) {}

  @Post(':id/events')
  @HttpCode(204)
  // 전역 세션 진입 예외는 전용 서비스 토큰 가드와 함께 사용한다.
  @SetMetadata(MVP_AI_ACCESS, true)
  @UseGuards(CallInsightsGuard)
  @AuditOperation({ action: 'CALL_EVENTS_RECORDED', targetType: 'CALL_SESSION', target: 'id' })
  @ApiOperation({
    summary: 'EVT-01 통화 이벤트 저장',
    description:
      '요청당 1~50개·100KiB. 통화 누적 개수 제한이 아니다. 위치는 정수 초이며 AI 동작 status는 받지 않는다. 동일 재전송은 204, 충돌은 묶음 전체 롤백 후 409. 신규 FAQ_ANSWERED는 유효한 현재 FAQ에 고객 질문 스냅샷을 추가한다. FAQ 수정 전 발생·삭제 FAQ·5년 만료 사례는 스냅샷에 추가하지 않고 원본 이벤트는 보존한다.',
  })
  @ApiNoContentResponse({ description: '전체 저장 또는 동일 이벤트 재전송 성공. 본문 없음.' })
  save(
    @Param() params: CallIdParamsDto,
    @Body() input: CreateCallEventsDto,
    @Req() request: AuthRequest,
  ): Promise<void> {
    return this.events.save(params.id, input, request.requestId);
  }
}
