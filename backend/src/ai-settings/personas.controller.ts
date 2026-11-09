import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiCookieAuth,
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AiSettingsService } from './ai-settings.service';
import { PersonaApplicationService } from './persona-application.service';
import { ActivatePersonaDto } from './dto/persona-application.dto';
import {
  CreatePersonaDto,
  CommitPersonaDraftDto,
  PersonaIdDto,
  PersonaListQueryDto,
  UpdatePersonaDto,
} from './dto/persona-request.dto';
import {
  PersonaListResponseDto,
  PersonaDraftResponseDto,
  PersonaResponseDto,
  PersonaVersionResponseDto,
  PersonaVersionsResponseDto,
} from './dto/persona-response.dto';

@ApiTags('Personas')
@ApiCookieAuth('adminSession')
@Roles('SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '요청 형식 오류 또는 변경값 없음.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '관리자 세션 없음·만료.', type: ErrorResponseDto })
@ApiResponse({
  status: 403,
  description:
    '변경 요청의 개발자·최고 관리자 권한 또는 허용 Origin 오류. 조회는 모든 활성 관리자에게 허용됩니다.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 404, description: '페르소나 또는 버전 없음.', type: ErrorResponseDto })
@Controller('personas')
export class PersonasController {
  constructor(
    private readonly personas: AiSettingsService,
    private readonly applications: PersonaApplicationService,
  ) {}

  @Post(':id/activate')
  @HttpCode(202)
  @AuditOperation({ action: 'PERSONA_APPLY_REQUESTED', targetType: 'AI_PERSONA', target: 'id' })
  @ApiOperation({
    summary: '통화용 페르소나 publish',
    description:
      '사용자가 확인한 최신 HEAD의 식별자와 버전 번호를 보냅니다. 같은 유형도 새 HEAD를 다시 publish할 수 있습니다. 수락한 버전·UUID는 이후 저장과 무관하게 고정되며 AI 확인 전에는 기존 ACTIVE를 유지합니다. 요청 전에 HEAD가 달라졌으면 409입니다.',
  })
  @ApiAcceptedResponse({
    description: '반영 대기 버전. 실제 적용 완료가 아닙니다.',
    type: PersonaVersionResponseDto,
  })
  @ApiOkResponse({
    description: '현재 ACTIVE를 유지하고 다른 대기가 있으면 취소합니다.',
    type: PersonaVersionResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: '확인한 HEAD 식별자 또는 최신 저장 버전 충돌.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 422,
    description: '현재 AI가 지원하지 않는 설정.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: 'AI 옵션 확인 실패 또는 연동 미설정.',
    type: ErrorResponseDto,
  })
  async activate(
    @Param() params: PersonaIdDto,
    @Body() input: ActivatePersonaDto,
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    const version = await this.applications.request(
      params.id,
      input,
      request.admin.adminUserSeq,
      request.requestId,
    );
    if (version.status === 'ACTIVE') response.status(200);
    return this.personas.withAuthor(version);
  }

  @Get()
  @Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
  @ApiOperation({
    summary: '페르소나 목록 조회',
    description:
      '유형별 최신 확정 HEAD·초안과 실제 상담 적용 버전·publish 대기 버전·오류를 구분해 조회합니다. 초안 저장·HEAD 확정으로 상담 버전은 바뀌지 않습니다.',
  })
  @ApiOkResponse({ description: '페르소나 목록과 다음 페이지 여부.', type: PersonaListResponseDto })
  list(@Query() query: PersonaListQueryDto) {
    return this.personas.list(query);
  }

  @Post()
  @AuditOperation({ action: 'PERSONA_CREATED', targetType: 'AI_PERSONA_VERSION', target: 'none' })
  @ApiOperation({
    summary: '페르소나 등록',
    description:
      '역할·성격·톤·속도 지시문·맞장구·끼어들기 6개 항목과 음성 설정을 버전 1·INACTIVE로 저장합니다. promptText는 서버가 조합한 읽기 전용 본문이며 입력받지 않습니다. 실제 상담 적용은 별도 publish 요청입니다.',
  })
  @ApiCreatedResponse({ description: '생성한 전체 설정 버전.', type: PersonaVersionResponseDto })
  @ApiResponse({ status: 409, description: '고유 코드 중복.', type: ErrorResponseDto })
  @ApiResponse({ status: 422, description: 'AI 미지원 옵션.', type: ErrorResponseDto })
  @ApiResponse({
    status: 503,
    description: 'AI 옵션 API 미연결·연동 토큰 미설정.',
    type: ErrorResponseDto,
  })
  create(@Body() input: CreatePersonaDto, @Req() request: AuthRequest) {
    return this.personas.create(input, request.admin.adminUserSeq, request.requestId);
  }

  @Get(':id')
  @Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
  @ApiOperation({
    summary: '페르소나 상세 조회',
    description:
      '최신 확정 HEAD·작성 중 초안과 실제 상담 적용 버전·publish 대기 버전·오류를 반환합니다. 최신 HEAD와 상담 버전은 다를 수 있습니다.',
  })
  @ApiOkResponse({ description: '페르소나 상세.', type: PersonaResponseDto })
  detail(@Param() params: PersonaIdDto) {
    return this.personas.detail(params.id);
  }

  @Patch(':id')
  @AuditOperation({ action: 'PERSONA_DRAFT_SAVED', targetType: 'AI_PERSONA', target: 'id' })
  @ApiOperation({
    summary: '페르소나 초안 저장',
    description:
      '최초에는 확인한 HEAD로 초안을 만들고 이후 같은 유형의 초안 한 개를 덮어씁니다. 생략한 값은 기존 초안 또는 최초 HEAD에서 유지합니다. expectedVersion과 expectedDraftRevision을 함께 검사하며 HEAD·버전 이력·상담 적용·publish 대기는 바꾸지 않습니다.',
  })
  @ApiOkResponse({
    description: '저장한 초안. 정식 버전 번호를 부여하지 않습니다.',
    type: PersonaDraftResponseDto,
  })
  @ApiResponse({
    status: 409,
    description: 'HEAD 또는 초안 수정 식별값 충돌. 상세를 다시 조회합니다.',
    type: ErrorResponseDto,
  })
  @ApiResponse({ status: 422, description: 'AI 미지원 옵션.', type: ErrorResponseDto })
  @ApiResponse({ status: 503, description: 'AI 지원 옵션 확인 실패.', type: ErrorResponseDto })
  update(
    @Param() params: PersonaIdDto,
    @Body() input: UpdatePersonaDto,
    @Req() request: AuthRequest,
  ) {
    return this.personas.update(params.id, input, request.admin.adminUserSeq, request.requestId);
  }

  @Post(':id/versions')
  @HttpCode(200)
  @AuditOperation({ action: 'PERSONA_UPDATED', targetType: 'AI_PERSONA', target: 'id' })
  @ApiOperation({
    summary: '초안을 정식 버전으로 확정하고 HEAD로 지정',
    description:
      '확인한 HEAD와 초안 수정 식별값으로 기존 초안만 확정합니다. 새 INACTIVE 버전 추가와 초안 삭제를 같은 트랜잭션에서 처리합니다. HEAD와 내용이 같으면 버전 추가 없이 초안만 삭제합니다. 실제 상담·publish 대기는 유지합니다. 재전송으로 버전을 중복 생성하지 않으며 이미 확정·변경된 요청은 409입니다.',
  })
  @ApiOkResponse({ description: '확정한 HEAD 전체 설정.', type: PersonaVersionResponseDto })
  @ApiResponse({
    status: 409,
    description: '초안 없음, HEAD·초안 충돌 또는 버전 번호 한도.',
    type: ErrorResponseDto,
  })
  @ApiResponse({
    status: 422,
    description: 'AI가 현재 지원하지 않는 설정.',
    type: ErrorResponseDto,
  })
  @ApiResponse({ status: 503, description: 'AI 지원 옵션 확인 실패.', type: ErrorResponseDto })
  commit(
    @Param() params: PersonaIdDto,
    @Body() input: CommitPersonaDraftDto,
    @Req() request: AuthRequest,
  ) {
    return this.personas.commitDraft(
      params.id,
      input,
      request.admin.adminUserSeq,
      request.requestId,
    );
  }

  @Get(':id/versions')
  @Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
  @ApiOperation({
    summary: '페르소나 버전 이력 조회',
    description:
      '이름·프롬프트·음성·속도·대기를 함께 보관한 이력을 최신순으로 반환합니다. 이전 설정은 덮어쓰지 않습니다.',
  })
  @ApiOkResponse({
    description: '전체 버전 이력과 다음 페이지 여부.',
    type: PersonaVersionsResponseDto,
  })
  versions(@Param() params: PersonaIdDto, @Query() query: PersonaListQueryDto) {
    return this.personas.versions(params.id, query);
  }
}
