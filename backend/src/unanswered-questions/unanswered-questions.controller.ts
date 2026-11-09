import { Body, Controller, Post, Req, Res, SetMetadata, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest } from '../auth/auth.guard';
import { MVP_AI_ACCESS } from '../auth/mvp-ai-access';
import { CallInsightsGuard } from '../call-insights/call-insights.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CreateUnansweredQuestionDto } from './dto/create-unanswered-question.dto';
import {
  CollectedUnansweredQuestionDto,
  UnansweredQuestionResponseDto,
} from './dto/unanswered-question-response.dto';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@ApiTags('Unanswered Questions')
@ApiBearerAuth()
@ApiResponse({
  status: 400,
  type: ErrorResponseDto,
  description: '질문·식별자·시각·위치 또는 추가 필드 오류.',
})
@ApiResponse({ status: 401, type: ErrorResponseDto, description: '유효한 AI 통화 기록 토큰 필요.' })
@ApiResponse({ status: 403, type: ErrorResponseDto, description: '통화와 AI 세션 불일치.' })
@ApiResponse({ status: 404, type: ErrorResponseDto, description: '통화 없음.' })
@ApiResponse({
  status: 409,
  type: ErrorResponseDto,
  description: '같은 발생 ID를 다른 내용·통화에 사용.',
})
@ApiResponse({ status: 413, type: ErrorResponseDto, description: '본문 100KiB 초과.' })
@ApiResponse({ status: 422, type: ErrorResponseDto, description: '저장할 수 없는 발생 시각.' })
@ApiResponse({
  status: 500,
  type: ErrorResponseDto,
  description: '저장·감사 실패. 질문 저장 롤백.',
})
@ApiResponse({ status: 503, type: ErrorResponseDto, description: 'AI 통화 기록 인증 미설정.' })
@Controller('ai/unanswered-questions')
export class UnansweredQuestionsController {
  constructor(private readonly questions: UnansweredQuestionsService) {}

  @Post()
  @SetMetadata(MVP_AI_ACCESS, true)
  @UseGuards(CallInsightsGuard)
  @AuditOperation({
    action: 'UNANSWERED_QUESTION_RECORDED',
    targetType: 'UNANSWERED_QUESTION',
    target: 'none',
  })
  @ApiOperation({
    summary: 'AI 미답변 질문 수집',
    description:
      '질문 한 건을 OPEN으로 저장합니다. 위치는 정수 초 또는 null. 최초 201, 동일 발생 재전송은 상태·원문을 변경하지 않고 200입니다. AI 토큰 전용이며 통화 처리 이벤트는 별도로 전송합니다.',
  })
  @ApiCreatedResponse({ type: UnansweredQuestionResponseDto, description: '새 질문 발생 저장.' })
  @ApiOkResponse({
    type: UnansweredQuestionResponseDto,
    description: '동일 발생 재전송. 기존 질문 번호 반환.',
  })
  async collect(
    @Body() input: CreateUnansweredQuestionDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CollectedUnansweredQuestionDto> {
    const result = await this.questions.collect(input, request.requestId);
    response.status(result.created ? 201 : 200);
    return { unansweredQuestionSeq: result.id };
  }
}
