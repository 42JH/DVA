import { ReportCallAnalysisFailureDto } from './dto/report-call-analysis-failure.dto';
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
import type { AuthRequest } from '../auth/auth.guard';
import { MVP_AI_ACCESS } from '../auth/mvp-ai-access';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CallIdParamsDto } from '../consultations/dto/call-id-params.dto';
import { CallInsightsGuard } from './call-insights.guard';
import { CallInsightsService } from './call-insights.service';
import { CreateCallAnalysisDto } from './dto/create-call-analysis.dto';

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
export class CallInsightsController {
  constructor(private readonly insights: CallInsightsService) {}

  @Post(':id/analysis/failure')
  @HttpCode(204)
  @SetMetadata(MVP_AI_ACCESS, true)
  @UseGuards(CallInsightsGuard)
  @AuditOperation({
    action: 'CALL_ANALYSIS_FAILED',
    targetType: 'CALL_SESSION',
    target: 'id',
  })
  @ApiOperation({
    summary: '통화 분석 최종 실패 통보',
    description:
      'AI_INSIGHTS_TOKEN 전용. 분석 단계의 최종 실패만 통보하며 일시 장애·다른 단계 실패는 제외합니다. 통화 번호와 providerCallId를 확인하고 최초 실패만 기록합니다. 중복 요청과 이미 정상 분석이 저장된 통화도 204입니다. PBX 종료 시각·녹취·주문·기존 분석을 변경하지 않습니다.',
  })
  @ApiNoContentResponse({
    description: '최초 실패 기록 또는 중복/완료 우선 처리. 본문 없음.',
  })
  reportFailure(
    @Param() params: CallIdParamsDto,
    @Body() input: ReportCallAnalysisFailureDto,
    @Req() request: AuthRequest,
  ): Promise<void> {
    return this.insights.reportFailure(params.id, input, request.requestId);
  }

  @Post(':id/analysis')
  @HttpCode(204)
  // 전역 세션 진입 예외는 반드시 전용 서비스 토큰 가드와 함께 사용한다.
  @SetMetadata(MVP_AI_ACCESS, true)
  @UseGuards(CallInsightsGuard)
  @AuditOperation({
    action: 'CALL_ANALYSIS_RECORDED',
    targetType: 'CALL_SESSION',
    target: 'id',
  })
  @ApiOperation({
    summary: 'ANL-01 통화 종료 분석 결과 저장',
    description:
      'AI 전용. 기존 통화에 최종 분석 1개를 저장합니다. 같은 내용의 재전송은 204, 다른 내용은 409입니다. 관리자 쿠키만으로 호출할 수 없으며 주문·PBX 시각을 변경하지 않습니다.',
  })
  @ApiNoContentResponse({
    description: '최초 저장 또는 동일 내용 재전송 성공. 본문 없음.',
  })
  save(
    @Param() params: CallIdParamsDto,
    @Body() input: CreateCallAnalysisDto,
    @Req() request: AuthRequest,
  ): Promise<void> {
    return this.insights.save(params.id, input, request.requestId);
  }
}
