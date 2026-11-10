import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiCookieAuth,
  ApiOperation,
  ApiOkResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AdminOrderListQueryDto, AdminOrderListResponseDto } from './dto/admin-order-list.dto';
import { OrdersService } from './orders.service';

@ApiTags('Admin Orders')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

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
}
