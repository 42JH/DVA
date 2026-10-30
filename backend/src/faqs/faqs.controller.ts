import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiBody,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import {
  CreateFaqDto,
  CreateFaqsDto,
  DeleteFaqsDto,
  FaqIdParamsDto,
  FaqQueryDto,
  UpdateFaqDto,
} from './dto/faq-request.dto';
import { CreateFaqPipe } from './create-faq.pipe';
import { FaqListResponseDto, FaqResponseDto } from './dto/faq-response.dto';
import { FaqsService } from './faqs.service';

@ApiTags('FAQs')
@ApiExtraModels(CreateFaqDto, CreateFaqsDto)
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '요청 형식·질문·답변·검색 조건 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '활성 관리자 세션 필요.', type: ErrorResponseDto })
@ApiResponse({ status: 403, description: '관리자 권한 또는 Origin 오류.', type: ErrorResponseDto })
@Controller('faqs')
export class FaqsController {
  constructor(private readonly faqs: FaqsService) {}

  @Get()
  @ApiOperation({
    summary: '관리자 FAQ 목록 조회',
    description: '모든 활성 관리자 허용. 질문·답변을 검색하며 FAQ 번호 오름차순으로 조회합니다.',
  })
  @ApiOkResponse({ type: FaqListResponseDto })
  list(@Query() query: FaqQueryDto) {
    return this.faqs.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '관리자 FAQ 상세 조회' })
  @ApiOkResponse({ type: FaqResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'FAQ 없음.' })
  find(@Param() params: FaqIdParamsDto) {
    return this.faqs.find(params.id);
  }

  @Post()
  @HttpCode(204)
  @AuditOperation({ action: 'FAQ_CREATED', targetType: 'FAQ_ENTRY', target: 'none' })
  @ApiOperation({
    summary: '관리자 FAQ 단건·복수 등록',
    description:
      'items에 1~100건을 전달합니다. 기존 질문·답변 단건 본문도 지원합니다. 전체 저장·감사 기록은 함께 커밋하거나 롤백합니다.',
  })
  @ApiBody({
    schema: {
      oneOf: [{ $ref: getSchemaPath(CreateFaqDto) }, { $ref: getSchemaPath(CreateFaqsDto) }],
    },
  })
  @ApiNoContentResponse({ description: '저장 완료. 한 건이면 Location에 새 FAQ 상세 경로 반환.' })
  async create(
    @Body(new CreateFaqPipe()) items: CreateFaqDto[],
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const ids = await this.faqs.create(items, request.admin.adminUserSeq, request.requestId);
    if (ids.length === 1) response.location(`/api/faqs/${ids[0]}`);
  }

  @Delete()
  @HttpCode(204)
  @AuditOperation({ action: 'FAQ_DELETED', targetType: 'FAQ_ENTRY', target: 'none' })
  @ApiOperation({
    summary: '관리자 FAQ 단건·복수 삭제',
    description:
      'faqEntrySeqs에 중복 없는 번호 1~100개를 전달합니다. 대상이 하나라도 없으면 전체 롤백합니다. 감사 로그는 보존합니다.',
  })
  @ApiNoContentResponse({ description: '전체 삭제 완료.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: '삭제 대상 FAQ 없음.' })
  async delete(@Body() input: DeleteFaqsDto, @Req() request: AuthRequest): Promise<void> {
    await this.faqs.delete(input.faqEntrySeqs, request.admin.adminUserSeq, request.requestId);
  }

  @Patch(':id')
  @HttpCode(204)
  @AuditOperation({ action: 'FAQ_UPDATED', targetType: 'FAQ_ENTRY', target: 'id' })
  @ApiOperation({
    summary: '관리자 FAQ 수정',
    description:
      '전달한 질문·답변만 변경합니다. 버전 비교 없이 요청을 처리하고 AI 조회에는 커밋된 최신 내용이 보입니다.',
  })
  @ApiNoContentResponse({ description: '수정 완료.' })
  @ApiResponse({ status: 404, type: ErrorResponseDto, description: 'FAQ 없음.' })
  async update(
    @Param() params: FaqIdParamsDto,
    @Body() input: UpdateFaqDto,
    @Req() request: AuthRequest,
  ): Promise<void> {
    await this.faqs.update(params.id, input, request.admin.adminUserSeq, request.requestId);
  }
}
