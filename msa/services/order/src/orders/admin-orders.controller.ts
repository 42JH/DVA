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
      '디자인/목업 03 주문 내역용. 저장된 주문당 한 줄이며 모든 배송상세를 parcels로 제공합니다. 생성 시각·주문 번호 내림차순. 검색·기간·상태 탭을 AND로 적용합니다. 주문 저장 전 통화는 포함하지 않습니다.',
  })
  @ApiOkResponse({ type: AdminOrderListResponseDto })
  @ApiBadRequestResponse({
    type: ErrorResponseDto,
    description: '검색·기간·상태 탭·페이지 조건 오류.',
  })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto, description: '활성 관리자 세션 필요.' })
  list(@Query() query: AdminOrderListQueryDto) {
    return this.orders.adminList(query);
  }
}
