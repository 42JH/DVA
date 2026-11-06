import { Controller, Delete, HttpCode, Param, Req } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuditOperation } from '../audit/audit-operation';
import { type AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ApiException } from '../common/errors/api.exception';
import { UnansweredQuestionIdDto } from './dto/unanswered-question-id.dto';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@ApiTags('Unanswered Questions')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  type: ErrorResponseDto,
  description: '질문 번호 또는 요청 필드 오류.',
})
@ApiResponse({
  status: 401,
  type: ErrorResponseDto,
  description: '활성 관리자 세션 필요.',
})
@ApiResponse({
  status: 403,
  type: ErrorResponseDto,
  description: '권한 또는 Origin 오류.',
})
@ApiResponse({
  status: 404,
  type: ErrorResponseDto,
  description: '미답변 질문 없음.',
})
@ApiResponse({
  status: 409,
  type: ErrorResponseDto,
  description: '현재 질문 상태 또는 기존 전환 내용과 충돌.',
})
@ApiResponse({
  status: 413,
  type: ErrorResponseDto,
  description: '본문 100KiB 초과.',
})
@ApiResponse({
  status: 500,
  type: ErrorResponseDto,
  description: '저장·감사 실패. 업무 변경 전체 롤백.',
})
@Controller('unanswered-questions')
export class UnansweredQuestionsManagementController {
  constructor(private readonly questions: UnansweredQuestionsService) {}

  @Delete(':id')
  @HttpCode(204)
  @AuditOperation({
    action: 'UNANSWERED_QUESTION_DELETED',
    targetType: 'UNANSWERED_QUESTION',
    target: 'id',
  })
  @ApiOperation({
    summary: '미처리 미답변 질문 삭제',
    description:
      'OPEN 질문 원문을 비우고 DELETED로 변경합니다. 발생 식별자·해시·통화 기록은 보존합니다. 이미 삭제했으면 204, FAQ 전환했으면 409입니다.',
  })
  @ApiNoContentResponse({
    description: '삭제 완료 또는 이미 삭제됨. 본문 없음.',
  })
  async delete(
    @Param() params: UnansweredQuestionIdDto,
    @Req() request: AuthRequest,
  ): Promise<void> {
    const body: unknown = request.body;
    if (
      body !== undefined &&
      (body === null ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length > 0)
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '삭제 요청에는 본문 필드를 보내지 않습니다.',
      );
    await this.questions.delete(
      params.id,
      request.admin.adminUserSeq,
      request.requestId,
    );
  }
}
