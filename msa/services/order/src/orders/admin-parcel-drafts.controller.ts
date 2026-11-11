import { Body, Post } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';
import { RequestMetaDto } from '../common/dto/api-response.dto';
import { AdminParcelDraftResultDto, SubmitAdminParcelDraftDto } from './dto/admin-parcel-draft.dto';
import { Controller, Delete, HttpCode, Param, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type AuthRequest, Roles } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AdminParcelDraftsService } from './admin-parcel-drafts.service';
import { DraftIdParamsDto } from './dto/parcel-draft.dto';

@ApiTags('Parcel drafts')
@ApiExtraModels(AdminParcelDraftResultDto, RequestMetaDto)
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 422, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller()
export class AdminParcelDraftsController {
  constructor(private readonly drafts: AdminParcelDraftsService) {}

  @Post('admin/parcel-drafts/:id/submit')
  @HttpCode(200)
  @AuditOperation({
    action: 'PARCEL_DRAFT_CONVERTED',
    targetType: 'ORDER_PARCEL_DRAFT',
    target: 'id',
  })
  @ApiOperation({
    summary: '관리자 보완 배송 최종 접수',
    description:
      'ACTIVE 관리자 세션·허용 Origin 필수. 미완료는 POST parcel-drafts의 sourceDraftSeq로 단독 초안에 복사하고 PATCH로 READY 확정한 뒤 호출합니다. 별도 ADMIN 주문으로 접수하며 기존 통화 주문에는 추가하지 않습니다. 카드 결제 대기 또는 기존 월·그룹결제와 디버 전송을 따릅니다. 이미 변환한 초안 재호출은 현재 주문만 반환합니다.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: { $ref: getSchemaPath(AdminParcelDraftResultDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  submit(
    @Param() params: DraftIdParamsDto,
    @Body() input: SubmitAdminParcelDraftDto,
    @Req() request: AuthRequest,
  ) {
    return this.drafts.submit(params.id, input, request.admin.adminUserSeq, request.requestId);
  }

  @Delete('parcel-drafts/:id')
  @HttpCode(204)
  @AuditOperation({
    action: 'PARCEL_DRAFT_DELETED',
    targetType: 'ORDER_PARCEL_DRAFT',
    target: 'id',
  })
  @ApiOperation({
    summary: '배송 초안 soft delete',
    description:
      '관리자 전용. 통화 확정 전 READY/EDITING은 삭제 불가. 초안만 일반 조회에서 숨기며 원본/재개/실제 주문과 텍스트를 연쇄 삭제하지 않습니다. 최초 보관 시작부터 5년 후 실제 폐기하며 삭제일로 연장하지 않습니다.',
  })
  @ApiNoContentResponse()
  delete(@Param() params: DraftIdParamsDto, @Req() request: AuthRequest) {
    return this.drafts.delete(params.id, request.admin.adminUserSeq, request.requestId);
  }
}
