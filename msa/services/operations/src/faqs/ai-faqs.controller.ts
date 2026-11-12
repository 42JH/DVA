import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { MvpAiFaqAccess } from '../auth/mvp-ai-access';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AiFaqQueryDto } from './dto/faq-request.dto';
import { AgentFaqListResponseDto } from './dto/faq-response.dto';
import { FaqsService } from './faqs.service';

@ApiTags('AI FAQs')
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@ApiResponse({ status: 400, description: '조회 조건 또는 번호 오류.', type: ErrorResponseDto })
@ApiResponse({
  status: 401,
  description: '유효한 관리자 세션 또는 AI_BUSINESS_TOKEN의 Bearer 인증 필요.',
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
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      'DB에 커밋된 최신 질문·답변 제공. faqEntrySeqs로 변경된 FAQ만 조회하거나 생략해 전체 조회합니다. FAQ 번호 오름차순, hasNext까지 순회하며 삭제·미존재 번호는 결과에서 제외합니다. 관리자 식별자는 제외합니다. AI_BUSINESS_TOKEN의 Bearer 인증 또는 관리자 세션이 필요하며 통화 헤더는 불필요합니다.',
  })
  @ApiOkResponse({ type: AgentFaqListResponseDto })
  list(@Query() query: AiFaqQueryDto) {
    return this.faqs.list(query, true);
  }
}
