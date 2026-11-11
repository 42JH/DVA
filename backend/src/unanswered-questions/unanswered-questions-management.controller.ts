import { DeleteQuestionsDto } from '../common/dto/delete-request.dto';
import { Body, Controller, Delete, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CreateFaqDto } from '../faqs/dto/faq-request.dto';
import { UnansweredQuestionIdDto } from './dto/unanswered-question-id.dto';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@ApiTags('Unanswered Questions')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@ApiResponse({ status: 400, type: ErrorResponseDto, description: '질문 번호 또는 요청 필드 오류.' })
@ApiResponse({ status: 401, type: ErrorResponseDto, description: '활성 관리자 세션 필요.' })
@ApiResponse({ status: 403, type: ErrorResponseDto, description: '권한 또는 Origin 오류.' })
@ApiResponse({ status: 404, type: ErrorResponseDto, description: '미답변 질문 없음.' })
@ApiResponse({
  status: 409,
  type: ErrorResponseDto,
  description: '현재 질문 상태 또는 기존 전환 내용과 충돌.',
})
@ApiResponse({ status: 413, type: ErrorResponseDto, description: '본문 100KiB 초과.' })
@ApiResponse({
  status: 500,
  type: ErrorResponseDto,
  description: '저장·감사 실패. 업무 변경 전체 롤백.',
})
@Controller('unanswered-questions')
export class UnansweredQuestionsManagementController {
  constructor(private readonly questions: UnansweredQuestionsService) {}

  @Post(':id/faqs')
  @HttpCode(204)
  @AuditOperation({
    action: 'UNANSWERED_QUESTION_REGISTERED',
    targetType: 'UNANSWERED_QUESTION',
    target: 'id',
  })
  @ApiOperation({
    summary: '미답변 질문을 FAQ로 전환',
    description:
      '분류·질문·답변 모두 필수입니다. FAQ·감사·AI 알림 대기·REGISTERED 전환을 함께 저장합니다. 같은 내용 재시도는 기존 FAQ를 유지합니다.',
  })
  @ApiNoContentResponse({
    description: '전환 완료 또는 동일 전환 재시도. Location에 FAQ 상세 경로.',
  })
  async convert(
    @Param() params: UnansweredQuestionIdDto,
    @Body() input: CreateFaqDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const id = await this.questions.convert(
      params.id,
      input,
      request.admin.adminUserSeq,
      request.requestId,
    );
    response.location(`/api/faqs/${id}`);
  }

  @Delete()
  @HttpCode(204)
  @AuditOperation({
    action: 'UNANSWERED_QUESTION_DELETED',
    targetType: 'UNANSWERED_QUESTION',
    target: 'ids',
    idsField: 'unansweredQuestionSeqs',
  })
  @ApiOperation({
    summary: '미처리 미답변 질문 삭제',
    description:
      'OPEN 질문 원문을 비우고 DELETED로 변경합니다. 발생 식별자·해시·통화 기록은 보존합니다. 이미 삭제했으면 204, FAQ 전환했으면 409입니다.',
  })
  @ApiNoContentResponse({ description: '삭제 완료 또는 이미 삭제됨. 본문 없음.' })
  async delete(@Body() input: DeleteQuestionsDto, @Req() request: AuthRequest) {
    await this.questions.delete(
      input.unansweredQuestionSeqs,
      request.admin.adminUserSeq,
      request.requestId,
    );
  }
}
