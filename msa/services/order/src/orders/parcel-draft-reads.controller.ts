import { Body, Controller, Get, Headers, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { type AuthRequest, Roles } from '../auth/auth.guard';
import { MvpAiOrderAccess as AiOrAdminAccess } from '../auth/mvp-ai-access';
import { AuditOperation } from '../audit/audit-operation';
import { ParcelDraftWritesService } from './parcel-draft-writes.service';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import {
  DraftIdParamsDto,
  CreateParcelDraftDto,
  PatchParcelDraftDto,
  ParcelDraftQueryDto,
  ParcelDraftResponseDto,
} from './dto/parcel-draft.dto';
import { ParcelDraftReadsService as ParcelDraftsService } from './parcel-draft-reads.service';
const envelope = {
  type: 'object' as const,
  required: ['data', 'meta'],
  properties: {
    data: { $ref: getSchemaPath(ParcelDraftResponseDto) },
    meta: { $ref: getSchemaPath(RequestMetaDto) },
  },
};

@ApiTags('Parcel drafts')
@ApiExtraModels(ParcelDraftResponseDto, RequestMetaDto)
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 422, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@ApiHeader({
  name: 'call_session_seq',
  required: false,
  description: 'AI 필수 통화 번호. 관리자 단독 초안은 헤더 없이 사용.',
  schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
})
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@Controller('parcel-drafts')
export class ParcelDraftsController {
  constructor(
    private readonly drafts: ParcelDraftsService,
    private readonly writes: ParcelDraftWritesService,
  ) {}

  @Post()
  @AiOrAdminAccess()
  @AuditOperation({
    action: 'PARCEL_DRAFT_CREATED',
    targetType: 'ORDER_PARCEL_DRAFT',
    target: 'none',
  })
  @ApiOperation({
    summary: '배송 초안 생성·미완료 재개',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '미등록 고객도 EDITING은 보존하며 READY에는 활성 고객이 필요합니다. 통화 중에는 실제 주문·결제·디버 요청을 생성하지 않습니다. 동일 clientParcelId·동일 생성 본문 재전송은 현재 초안을 반환하며, 다른 본문은 409입니다. AI는 완료 신호 전까지 종료 후 정리 전송도 가능합니다. 재개는 같은 고객의 INCOMPLETE를 새 초안으로 복사하며 원본 보관 기한을 상속합니다.',
  })
  @ApiCreatedResponse({ schema: envelope })
  create(
    @Req() request: AuthRequest,
    @Body() input: CreateParcelDraftDto,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.writes.create(
      request.admin?.adminUserSeq ?? null,
      input,
      request.requestId,
      header,
    );
  }

  @Patch(':id')
  @AiOrAdminAccess()
  @AuditOperation({
    action: 'PARCEL_DRAFT_UPDATED',
    targetType: 'ORDER_PARCEL_DRAFT',
    target: 'id',
  })
  @ApiOperation({
    summary: '배송 초안 수정 시작·저장·취소',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      'READY 수정은 START_EDIT와 clearFields로 먼저 EDITING 전환합니다. SAVE는 부분 필드를 병합하고 READY 시 전체 필수값을 검증합니다. expectedVersion 불일치 409. 응답 유실은 GET으로 확인하며 오래된 버전을 재적용하지 않습니다. AI 완료 신호 이후 수정 불가. 관리자도 통화 초안은 INCOMPLETE를 새 단독 초안으로 재개해 보완합니다.',
  })
  @ApiOkResponse({ schema: envelope })
  patch(
    @Req() request: AuthRequest,
    @Param() params: DraftIdParamsDto,
    @Body() input: PatchParcelDraftDto,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.writes.patch(
      request.admin?.adminUserSeq ?? null,
      params.id,
      input,
      request.requestId,
      header,
    );
  }

  @Get()
  @AiOrAdminAccess()
  @ApiOperation({
    summary: '미완료·배송 초안 목록',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '기본 INCOMPLETE. status=ALL로 전체 상태, customerSeq·callSessionSeq·legacyOrderSeq·q 필터와 limit/offset을 사용합니다. 최신 생성 시각·번호순. AI는 같은 고객만 조회하며 미등록 이력은 최초 발신번호 사본을 확인합니다. 종료 통화는 그 통화의 초안만 조회합니다. 삭제/5년 만료는 숨깁니다.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['data', 'hasNext', 'total_count'],
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(ParcelDraftResponseDto) } },
        hasNext: { type: 'boolean' },
        total_count: { type: 'integer', minimum: 0 },
      },
    },
  })
  list(
    @Req() request: AuthRequest,
    @Query() query: ParcelDraftQueryDto,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.drafts.list(request.admin?.adminUserSeq ?? null, query, header);
  }

  @Get(':id')
  @AiOrAdminAccess()
  @ApiOperation({
    summary: '배송 초안 상세',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '원본 고객·통화·주문을 JOIN하지 않고 독립 스냅샷과 논리 참조 번호를 반환합니다. 관리자 조회는 참조 원본 삭제 후에도 가능합니다. version은 해당 초안, intakeVersion은 현재 AI 통화 집합의 버전입니다.',
  })
  @ApiOkResponse({ schema: envelope })
  detail(
    @Req() request: AuthRequest,
    @Param() params: DraftIdParamsDto,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.drafts.detail(request.admin?.adminUserSeq ?? null, params.id, header);
  }
}
