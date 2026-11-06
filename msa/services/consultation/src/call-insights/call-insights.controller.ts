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
