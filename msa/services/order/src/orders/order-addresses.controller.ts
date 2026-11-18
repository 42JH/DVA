import { Controller, Get, Headers, Param, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type AuthRequest, Roles } from '../auth/auth.guard';
import { MvpAiOrderAccess } from '../auth/mvp-ai-access';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CustomerIdParamsDto } from './dto/customer-id-params.dto';
import {
  OrderAddressHistoryEnvelopeDto,
  OrderAddressHistoryQueryDto,
} from './dto/order-address-history.dto';
import { OrdersService } from './orders.service';

@ApiTags('Orders')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@Controller('customers')
export class OrderAddressesController {
  constructor(private readonly orders: OrdersService) {}

  @Get(':id/addresses')
  @MvpAiOrderAccess()
  @ApiOperation({
    summary: '이전 주문 기반 출발지·도착지 조회',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      'ACCEPTED 주문의 주소 스냅샷만 조회합니다. 기간은 주문 생성 시각 기준이며 같은 주소도 주문 상세별로 반환합니다. AI는 AI_BUSINESS_TOKEN의 Bearer 인증과 진행 중 통화 고객, 관리자는 세션과 지정 고객 범위입니다. PIN 저장 여부와 무관하며 외부 디버 API는 호출하지 않습니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description: 'AI 필수·관리자 불필요. 기존 DB 통화 번호이며 인증 토큰은 아닙니다.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiOkResponse({ type: OrderAddressHistoryEnvelopeDto })
  list(
    @Param() params: CustomerIdParamsDto,
    @Query() query: OrderAddressHistoryQueryDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.orders.addressHistory(
      request.admin?.adminUserSeq ?? null,
      params.id,
      query,
      header,
    );
  }
}
