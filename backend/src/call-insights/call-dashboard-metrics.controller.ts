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
import { CallDashboardMetricsService } from './call-dashboard-metrics.service';
import {
  CreateResponseWaitMetricsDto,
  CreateStageMetricsDto,
} from './dto/create-call-dashboard-metrics.dto';

@ApiTags('Call Insights')
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 422, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('ai/calls')
export class CallDashboardMetricsController {
  constructor(private readonly metrics: CallDashboardMetricsService) {}

  @Post(':id/stage-metrics')
  @HttpCode(204)
  @SetMetadata(MVP_AI_ACCESS, true)
  @UseGuards(CallInsightsGuard)
  @AuditOperation({ action: 'CALL_DROPOFF_RECORDED', targetType: 'CALL_SESSION', target: 'id' })
  @ApiOperation({
    summary: '통화 최종 이탈 단계 저장',
    description:
      'analysis 저장 후 전송. NONE 이탈 없음. 최초/동일 재전송 204, 변경 409. 기존 분석·다른 지표를 변경하지 않습니다.',
  })
  @ApiNoContentResponse({ description: '최초 저장 또는 동일 내용 재전송. 본문 없음.' })
  saveStage(
    @Param() params: CallIdParamsDto,
    @Body() input: CreateStageMetricsDto,
    @Req() request: AuthRequest,
  ) {
    return this.metrics.saveStage(params.id, input, request.requestId);
  }

  @Post(':id/response-wait-metrics')
  @HttpCode(204)
  @SetMetadata(MVP_AI_ACCESS, true)
  @UseGuards(CallInsightsGuard)
  @AuditOperation({
    action: 'CALL_RESPONSE_WAIT_RECORDED',
    targetType: 'CALL_SESSION',
    target: 'id',
  })
  @ApiOperation({
    summary: '통화 최종 대기시간·유형별 레이턴시 요약 저장',
    description:
      'analysis 저장 후 전송. AI가 겹침을 제외한 총 대기시간을 보냅니다. 측정 결과 대기가 없으면 0/[]. 미측정은 전송하지 않습니다. 배열 순서 차이는 동일 재전송. P95·원본 표본은 받지 않습니다.',
  })
  @ApiNoContentResponse({ description: '최초 저장 또는 동일 내용 재전송. 본문 없음.' })
  saveResponseWait(
    @Param() params: CallIdParamsDto,
    @Body() input: CreateResponseWaitMetricsDto,
    @Req() request: AuthRequest,
  ) {
    return this.metrics.saveResponseWait(params.id, input, request.requestId);
  }
}
