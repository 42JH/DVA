import { CancelOrderParcelsDto } from './dto/cancel-order-parcels.dto';
import {
  Body,
  Post,
  Controller,
  Delete,
  HttpCode,
  Get,
  Headers,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiTags,
  ApiNoContentResponse,
  ApiExtraModels,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiHeader,
  ApiOperation,
  ApiOkResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { AuditOperation } from '../audit/audit-operation';
import { MvpAiOrderAccess } from '../auth/mvp-ai-access';
import { type AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { OrderDetailDto, OrderSummaryDto } from './dto/order-response.dto';
import { OrderIdParamsDto, OrderQueryDto } from './dto/order-query.dto';
import { OrdersService } from './orders.service';

@ApiTags('Orders')
@ApiExtraModels(OrderSummaryDto, OrderDetailDto, RequestMetaDto, ErrorResponseDto)
@ApiBadRequestResponse({
  description: '요청 값의 형식·범위 오류 또는 필수 값 누락.',
  type: ErrorResponseDto,
})
@ApiUnauthorizedResponse({
  description: '전달한 관리자 세션이 유효하지 않음.',
  type: ErrorResponseDto,
})
@ApiForbiddenResponse({
  description: '접근 권한·Origin 오류 또는 고객·통화·주소록 접근 불가.',
  type: ErrorResponseDto,
})
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Delete(':id')
  @HttpCode(204)
  @AuditOperation({ action: 'ORDER_DELETED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '주문 soft delete',
    description:
      '활성 관리자 세션·허용 Origin 필수. 주문 및 하위 이력을 일반 조회에서 숨깁니다. 통화·결제·접수 진행 중에는 409이며 결제 취소를 대신하지 않습니다. 실제 폐기는 최초 완료/취소(미완료는 생성) 시각부터 5년 후 수행합니다.',
  })
  @ApiNoContentResponse({ description: '삭제 처리 완료.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: '없거나 삭제·만료된 주문.' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: '진행 중인 통화·결제·접수.' })
  delete(@Param() params: OrderIdParamsDto, @Req() request: AuthRequest) {
    return this.orders.delete(params.id, request.admin!.adminUserSeq, request.requestId);
  }

  @Get()
  @MvpAiOrderAccess()
  @ApiOperation({
    summary: '주문 목록 조회',
    security: [{ adminSession: [] }, {}],
    description:
      '주문 상태·고객·생성 기간·수령인으로 검색하고, 생성 시각·주문 번호 내림차순으로 반환합니다. 필터는 모두 AND 조건입니다. 주소·물품은 주문 상세에서 조회합니다.\n\n관리자는 전체 주문, AI는 진행 중 통화의 발신번호와 일치하는 활성 고객의 주문만 조회합니다. AI 서비스 인증은 아직 적용되지 않습니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description:
      'DB call_sessions.call_session_seq 값. AI 필수·관리자 불필요. 인증 토큰이 아닙니다.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiNotFoundResponse({ description: '통화가 없음.', type: ErrorResponseDto })
  @ApiForbiddenResponse({
    description: '관리자 권한이 없거나 통화의 활성 고객 범위를 벗어남.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: '종료된 통화의 AI 조회(INVALID_STATE).',
    type: ErrorResponseDto,
  })
  @ApiOkResponse({
    description: '주문 요약과 다음 페이지 존재 여부. 검색 결과가 없으면 data는 빈 배열입니다.',
    schema: {
      type: 'object',
      required: ['data', 'hasNext', 'total_count'],
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(OrderSummaryDto) } },
        total_count: { type: 'integer', minimum: 0, description: '검색·필터 후 전체 건수.' },
        hasNext: { type: 'boolean', description: '이후 주문이 더 있으면 true.' },
      },
    },
  })
  list(
    @Req() request: AuthRequest,
    @Query() query: OrderQueryDto,
    @Headers('call_session_seq') callSessionSeq?: string,
  ) {
    return this.orders.list(request.admin?.adminUserSeq ?? null, query, callSessionSeq);
  }

  @Post(':id/cancel')
  @HttpCode(204)
  @MvpAiOrderAccess()
  @AuditOperation({ action: 'ORDER_CANCELLED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '주문 전체 취소',
    security: [{ adminSession: [] }, {}],
    description:
      '신규 AI 통화의 수정·취소·확정은 배송 초안과 통화 주문 완료 API를 사용하며 이 쓰기 경로는 409입니다. 관리자의 기존 권한과 이전 통화 호환은 유지합니다.\n\nCOLLECTING 또는 notPaid 주문을 즉시 취소합니다. 주문·상세는 보존하고 총액을 0원으로 변경하며 결제 요청을 닫습니다. 결제 완료 이후 취소는 거절하며 디버 취소 API는 호출하지 않습니다. 이미 취소한 상세는 건너뛰고 주문 전체가 취소된 경우에만 409를 반환합니다. 본문·Idempotency-Key는 필요하지 않습니다.\n\n관리자는 모든 주문, AI는 기존 상세 조회와 같은 발신번호·활성 고객 범위만 허용합니다. AI 서비스 인증은 아직 적용되지 않습니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description:
      'DB call_sessions.call_session_seq. AI 필수·관리자 불필요. 종료된 통화는 기존 연결 주문만 허용.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiNotFoundResponse({
    description: '통화·주문이 없거나 AI 고객 범위 밖인 주문.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      '이미 취소된 주문, 취소 불가 주문·통화 상태 또는 결제 전 조건 불충족(INVALID_STATE).',
    type: ErrorResponseDto,
  })
  @ApiNoContentResponse({
    description: '취소 완료. 응답 본문 없음. 최신 상태·version은 주문 상세에서 조회합니다.',
  })
  cancel(
    @Req() request: AuthRequest,
    @Param() params: OrderIdParamsDto,
    @Headers('call_session_seq') callSessionSeq?: string,
  ) {
    return this.orders.cancel(
      request.admin?.adminUserSeq ?? null,
      params.id,
      request.requestId,
      callSessionSeq,
    );
  }

  @Post(':id/parcels/cancel')
  @HttpCode(204)
  @MvpAiOrderAccess()
  @AuditOperation({ action: 'ORDER_PARCEL_CANCELLED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '주문 상세 단건·복수 취소',
    security: [{ adminSession: [] }, {}],
    description:
      '신규 AI 통화의 수정·취소·확정은 배송 초안과 통화 주문 완료 API를 사용하며 이 쓰기 경로는 409입니다. 관리자의 기존 권한과 이전 통화 호환은 유지합니다.\n\norderParcelSeqs에 같은 주문의 상세번호를 한 개 이상 보냅니다. 이미 취소된 상세는 건너뛰고, 남은 대상이 모두 미완료 또는 결제 전(notPaid)일 때 한 번에 취소합니다. 하나라도 없거나 취소할 수 없으면 전부 변경하지 않습니다. 모든 상세가 취소되면 주문도 CANCELLED입니다. 전부 이미 취소된 요청은 변경·이력 추가 없이 204입니다.\n\n관리자는 전체, AI는 기존 상세 조회와 같은 발신번호·활성 고객 범위만 허용합니다. Idempotency-Key·expectedVersion은 필요하지 않습니다. 디버 취소 API와 AI 서비스 인증은 아직 적용되지 않습니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description:
      'DB call_sessions.call_session_seq. AI 필수·관리자 불필요. 종료된 통화는 기존 연결 주문만 허용.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiNotFoundResponse({
    description:
      '통화·주문이 없거나 AI 고객 범위 밖. 상세 중 하나라도 해당 주문에 없으면 전체 거절.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      '취소 불가 주문·통화 상태 또는 미취소 대상 중 하나라도 결제 전 조건 불충족(INVALID_STATE). 전체 거절.',
    type: ErrorResponseDto,
  })
  @ApiNoContentResponse({
    description:
      '선택한 상세 취소 완료 또는 모두 이미 취소됨. 본문 없음. 최신 상태·version은 주문 상세에서 조회합니다.',
  })
  cancelParcels(
    @Req() request: AuthRequest,
    @Param() params: OrderIdParamsDto,
    @Body() input: CancelOrderParcelsDto,
    @Headers('call_session_seq') callSessionSeq?: string,
  ) {
    return this.orders.cancel(
      request.admin?.adminUserSeq ?? null,
      params.id,
      request.requestId,
      callSessionSeq,
      input.orderParcelSeqs,
    );
  }

  @Get(':id')
  @MvpAiOrderAccess()
  @ApiOperation({
    summary: '주문 상세 조회',
    security: [{ adminSession: [] }, {}],
    description:
      '주문·상세 취소 상태, 고객·결제·수거 시각·주소·물품·디버 접수 결과와 현재 version을 반환합니다. 취소된 상세도 보존해 반환합니다. 미수집 값은 null, 상세가 없으면 parcels는 빈 배열입니다. 원본 PIN 변경은 주문 주소에 반영하지 않습니다.\n\nAI는 발신번호가 일치하는 활성 고객의 주문만 조회합니다. 종료된 통화는 저장 결과 확인을 위해 기존 연결 주문 한 건만 조회할 수 있습니다. AI 서비스 인증은 아직 적용되지 않습니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description:
      'DB call_sessions.call_session_seq 값. AI 필수·관리자 불필요. 인증 토큰이 아닙니다.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiNotFoundResponse({
    description: '통화·주문이 없거나 AI의 고객 범위 밖인 주문(NOT_FOUND).',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: '관리자 권한이 없거나 통화 발신번호에 연결된 활성 고객이 없음.',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description: '종료된 통화로 기존 연결 주문 외의 상세 조회(INVALID_STATE).',
    type: ErrorResponseDto,
  })
  @ApiOkResponse({
    description:
      '주문 상세와 요청 추적 정보. version을 다음 수정 요청의 expectedVersion으로 전달합니다.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(OrderDetailDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  detail(
    @Req() request: AuthRequest,
    @Param() params: OrderIdParamsDto,
    @Headers('call_session_seq') callSessionSeq?: string,
  ) {
    return this.orders.detail(request.admin?.adminUserSeq ?? null, params.id, callSessionSeq);
  }
}
