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
  PersonaIdDto,
  PersonaListQueryDto,
  UpdatePersonaDto,
} from './dto/persona-request.dto';
import {
  PersonaListResponseDto,
  PersonaResponseDto,
  PersonaVersionResponseDto,
  PersonaVersionsResponseDto,
} from './dto/persona-response.dto';

@ApiTags('Personas')
@ApiCookieAuth('adminSession')
@Roles('SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '요청 형식 오류 또는 변경값 없음.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '관리자 세션 없음·만료.', type: ErrorResponseDto })
@ApiResponse({
  status: 403,
  description: '최상위 관리자 권한 또는 변경 요청 Origin 오류.',
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
    summary: '페르소나 적용·복원 요청',
    description:
      '선택한 전체 버전을 PENDING으로 지정하고 기존 대기를 INACTIVE로 바꿉니다. 과거 버전도 선택할 수 있습니다. AI가 통화 0건에서 적용을 확인해야 ACTIVE가 바뀌며, 같은 정상 대기 요청은 재사용합니다.',
  })
  @ApiAcceptedResponse({
    description: '반영 대기 버전. 실제 적용 완료가 아닙니다.',
    type: PersonaVersionResponseDto,
  })
  @ApiOkResponse({
    description: '현재 ACTIVE를 유지하고 다른 대기가 있으면 취소합니다.',
    type: PersonaVersionResponseDto,
  })
  @ApiResponse({ status: 409, description: '최신 저장 버전 충돌.', type: ErrorResponseDto })
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
    return version;
  }

  @Get()
  @ApiOperation({
    summary: '페르소나 목록 조회',
    description:
      '최신 저장 설정과 적용·대기 버전 번호를 조회합니다. 최신 버전이 반드시 운영 버전은 아닙니다.',
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
      '전체 프롬프트와 음성 설정을 버전 1·INACTIVE로 저장합니다. 지원 옵션을 검증하며 운영 적용은 별도 요청합니다.',
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
  @ApiOperation({
    summary: '페르소나 상세 조회',
    description:
      '최신 설정과 이 페르소나의 적용·대기 버전 번호를 반환합니다. 과거 설정은 버전 목록에서 조회합니다.',
  })
  @ApiOkResponse({ description: '페르소나 상세.', type: PersonaResponseDto })
  detail(@Param() params: PersonaIdDto) {
    return this.personas.detail(params.id);
  }

  @Patch(':id')
  @AuditOperation({ action: 'PERSONA_UPDATED', targetType: 'AI_PERSONA', target: 'id' })
  @ApiOperation({
    summary: '페르소나 수정',
    description:
      '생략한 값은 유지하고 전체 설정의 새 버전을 저장합니다. 적용·대기 중인 페르소나를 수정하면 기존 대기를 교체하며, 운영 버전은 AI 적용 확인까지 유지합니다. 동일값 수정은 버전을 늘리지 않습니다.',
  })
  @ApiOkResponse({ description: '저장한 버전과 반영 상태.', type: PersonaVersionResponseDto })
  @ApiResponse({
    status: 409,
    description: 'expectedVersion이 최신 저장 버전과 다름.',
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

  @Get(':id/versions')
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
