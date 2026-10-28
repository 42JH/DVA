import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MvpAiFaqAccess } from '../auth/mvp-ai-access';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { FaqIdParamsDto, FaqQueryDto } from './dto/faq-request.dto';
import { AgentFaqListResponseDto, AgentFaqResponseDto } from './dto/faq-response.dto';
import { FaqsService } from './faqs.service';

@ApiTags('AI FAQs')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({ status: 400, description: '조회 조건 또는 번호 오류.', type: ErrorResponseDto })
@ApiResponse({
  status: 401,
  description: '관리자 쿠키를 전달한 경우 정상 세션 필요.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 403, description: '관리자 권한 또는 Origin 오류.', type: ErrorResponseDto })
@Controller('ai/faqs')
export class AiFaqsController {
  constructor(private readonly faqs: FaqsService) {}

  @Get()
  @MvpAiFaqAccess()
  @ApiOperation({
    summary: 'AI FAQ 목록 조회',
    security: [{ adminSession: [] }, {}],
    description:
      'DB에 커밋된 최신 질문·답변 제공. FAQ 번호 오름차순, hasNext까지 순회합니다. 관리자 식별자는 제외합니다. MVP 서비스 인증 생략, 통화 헤더 불필요. AI 검색 데이터 갱신은 AI 파트에서 처리합니다.',
  })
  @ApiOkResponse({ type: AgentFaqListResponseDto })
  list(@Query() query: FaqQueryDto) {
    return this.faqs.list(query, true);
  }

  @Get(':id')
  @MvpAiFaqAccess()
  @ApiOperation({
    summary: 'AI FAQ 상세 조회',
    security: [{ adminSession: [] }, {}],
    description:
      '해당 FAQ의 최신 원본 조회. 관리자 식별자는 제외하며 MVP 서비스 인증·통화 헤더 불필요.',
  })
  @ApiOkResponse({ type: AgentFaqResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'FAQ 없음.' })
  find(@Param() params: FaqIdParamsDto) {
    return this.faqs.find(params.id, true);
  }
}
