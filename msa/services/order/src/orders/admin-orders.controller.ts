import { Controller, Get, HttpCode, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiTags,
  ApiExtraModels,
  getSchemaPath,
  ApiCookieAuth,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuditOperation } from '../audit/audit-operation';
import type { AuthRequest } from '../auth/auth.guard';
import { OrderSubmissionService } from './order-submission.service';
import { OrderIdParamsDto } from './dto/order-query.dto';
import { SubmittedOrderDto } from './dto/submit-order.dto';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { AdminOrderListQueryDto, AdminOrderListResponseDto } from './dto/admin-order-list.dto';
import { OrdersService } from './orders.service';

@ApiTags('Admin Orders')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly submissions: OrderSubmissionService,
  ) {}

  @Get()
  @ApiOperation({
    summary: '관리자 주문 목록 화면 조회',
    description:
      '실제 주문과 INCOMPLETE 초안을 생성 시각·표시 주문번호 최신순으로 함께 조회합니다. 초안은 COLLECTING이며 draftSeq가 있고 orderSeq는 예약번호입니다. 실제 주문은 draftSeq=null입니다. COLLECTING 탭은 초안만 조회하며 검색·기간·현재 기업·페이지 조건과 total_count를 같은 기준으로 적용합니다. 통화 자체는 목록 행으로 만들지 않습니다.',
  })
  @ApiOkResponse({ type: AdminOrderListResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: '검색·기간·상태 탭·기업 번호·페이지 조건 오류.',
  })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: '활성 관리자 세션 필요.' })
  list(@Query() query: AdminOrderListQueryDto) {
    return this.orders.adminList(query);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @AuditOperation({ action: 'ORDER_RESUBMISSION_STARTED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '디버 접수 실패 주문 재접수',
    description:
      '결제된 같은 주문의 미취소 상세를 수동 재전송합니다. 결제·월별 사용액을 다시 처리하지 않으며 자동 재시도 10분 기한을 연장하지 않습니다. 10초가 지난 미확정 SUBMITTING은 실패 상태로 복구하고 반환하며, 처리 중·완료 주문은 현재 상태만 반환합니다.',
  })
  @ApiExtraModels(SubmittedOrderDto)
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        data: { $ref: getSchemaPath(SubmittedOrderDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  retry(@Param() params: OrderIdParamsDto, @Req() request: AuthRequest) {
    return this.submissions.retry(params.id, request.admin.adminUserSeq, request.requestId);
  }
}
