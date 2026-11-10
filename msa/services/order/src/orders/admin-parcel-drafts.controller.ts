import { Controller, Delete, HttpCode, Param, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type AuthRequest, Roles } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AdminParcelDraftsService } from './admin-parcel-drafts.service';
import { DraftIdParamsDto } from './dto/parcel-draft.dto';

@ApiTags('Parcel drafts')
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
