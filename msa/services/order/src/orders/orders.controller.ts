import { Patch } from '@nestjs/common';
import { ApiBody, ApiUnprocessableEntityResponse } from '@nestjs/swagger';
import { MvpAiCustomerAccess as AiOrAdminAccess } from '../auth/auth.guard';
import { UpdateOrderDto, UpdatedOrderDto } from './dto/update-order.dto';
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
@ApiExtraModels(OrderSummaryDto, OrderDetailDto, RequestMetaDto, ErrorResponseDto, UpdatedOrderDto)
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
    return this.orders.delete(params.id, request.admin.adminUserSeq, request.requestId);
  }

  @Get()
  @MvpAiOrderAccess()
  @ApiOperation({
    summary: '주문 목록 조회',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '주문 상태·고객·생성 기간·수령인으로 검색하고, 생성 시각·주문 번호 내림차순으로 반환합니다. 필터는 모두 AND 조건입니다. 주소·물품은 주문 상세에서 조회합니다.\n\n관리자는 전체 주문, AI는 진행 중 통화의 발신번호와 일치하는 활성 고객의 주문만 조회합니다. AI는 AI_BUSINESS_TOKEN의 Bearer 인증, 관리자는 유효한 세션이 필요합니다.',
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
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '신규 AI 통화의 수정·취소·확정은 배송 초안과 통화 주문 완료 API를 사용하며 이 쓰기 경로는 409입니다. 관리자의 기존 권한과 이전 통화 호환은 유지합니다.\n\nCOLLECTING 또는 notPaid 주문을 즉시 취소합니다. 주문·상세는 보존하고 총액을 0원으로 변경하며 결제 요청을 닫습니다. 결제 완료 이후 취소는 거절하며 디버 취소 API는 호출하지 않습니다. 이미 취소한 상세는 건너뛰고 주문 전체가 취소된 경우에만 409를 반환합니다. 본문·Idempotency-Key는 필요하지 않습니다.\n\n관리자는 모든 주문, AI는 기존 상세 조회와 같은 발신번호·활성 고객 범위만 허용합니다. AI는 AI_BUSINESS_TOKEN의 Bearer 인증, 관리자는 유효한 세션이 필요합니다.',
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
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '신규 AI 통화의 수정·취소·확정은 배송 초안과 통화 주문 완료 API를 사용하며 이 쓰기 경로는 409입니다. 관리자의 기존 권한과 이전 통화 호환은 유지합니다.\n\norderParcelSeqs에 같은 주문의 상세번호를 한 개 이상 보냅니다. 이미 취소된 상세는 건너뛰고, 남은 대상이 모두 미완료 또는 결제 전(notPaid)일 때 한 번에 취소합니다. 하나라도 없거나 취소할 수 없으면 전부 변경하지 않습니다. 모든 상세가 취소되면 주문도 CANCELLED입니다. 전부 이미 취소된 요청은 변경·이력 추가 없이 204입니다.\n\n관리자는 전체, AI는 기존 상세 조회와 같은 발신번호·활성 고객 범위만 허용합니다. Idempotency-Key·expectedVersion은 필요하지 않습니다. 디버 취소 API는 호출하지 않습니다. AI는 AI_BUSINESS_TOKEN의 Bearer 인증, 관리자는 유효한 세션이 필요합니다.',
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
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '주문·상세 취소 상태, 고객·결제·수거 시각·주소·물품·디버 접수 결과와 현재 version을 반환합니다. 취소된 상세도 보존해 반환합니다. 미수집 값은 null, 상세가 없으면 parcels는 빈 배열입니다. 원본 PIN 변경은 주문 주소에 반영하지 않습니다.\n\nAI는 발신번호가 일치하는 활성 고객의 주문만 조회합니다. 종료된 통화는 저장 결과 확인을 위해 기존 연결 주문 한 건만 조회할 수 있습니다. AI는 AI_BUSINESS_TOKEN의 Bearer 인증, 관리자는 유효한 세션이 필요합니다.',
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
  @Patch(':id')
  @AiOrAdminAccess()
  @AuditOperation({ action: 'ORDER_UPDATED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '주문 정보 수정',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '055 이후 등록 AI 통화는 배송 초안 API로 수정하며 이 경로는 409입니다. 이전 등록 통화의 AI는 COLLECTING 주문의 미취소 상세만 수정합니다. 관리자는 모든 주문 상태에서 상세 추가·수정·제거가 가능하며 상태·확정 결제수단은 유지합니다. 관리자 총액은 미취소 상세 배송비로 재계산하고 디버에는 전송하지 않습니다. 생략한 값은 유지하고 nullable 필드의 null은 값을 비웁니다.\n\nAI는 발신번호가 일치하는 활성 고객의 주문만 저장합니다. 진행 중 통화는 선택한 주문에 연결하고, 종료된 통화는 기존 연결 주문의 후처리만 허용합니다. AI는 AI_BUSINESS_TOKEN의 Bearer 인증, 관리자는 유효한 세션이 필요합니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description: 'DB call_sessions.call_session_seq 값. AI 필수·관리자 선택. 인증 토큰이 아닙니다.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiBody({
    type: UpdateOrderDto,
    description:
      'expectedVersion과 변경값이 필요합니다. 상세 번호가 없으면 새 상세를 추가합니다. 관리자 removeParcelSeqs는 이력을 보존하는 제거이며 totalAmount를 생략하면 서버가 계산합니다. 응답 유실·409 시 최신 상세를 조회해 재판단하며 새 상세를 무조건 재추가하지 않습니다.',
    examples: {
      changeAddress: {
        summary: '기존 상세의 도착지 일부 수정',
        value: {
          expectedVersion: 4,
          parcels: [{ orderParcelSeq: 101, destination: { roadAddress: '예시시 배송로 2' } }],
        },
      },
      appendParcel: {
        summary: '새 상세 추가',
        value: {
          expectedVersion: 4,
          parcels: [{ destination: { name: '수령인' }, smallBoxCount: 1 }],
        },
      },
      adminEdit: {
        summary: '관리자 상세 추가·수정·제거와 총액 재계산',
        value: {
          expectedVersion: 4,
          parcels: [
            { orderParcelSeq: 101, notifiedPrice: 3000 },
            { destination: { name: '새 수령인' }, smallBoxCount: 1, notifiedPrice: 4000 },
          ],
          removeParcelSeqs: [102],
        },
      },
      clearPickup: {
        summary: '수거 요청 시각 비우기',
        value: { expectedVersion: 4, pickupRequestedAt: null },
      },
    },
  })
  @ApiBadRequestResponse({
    description: '형식·범위 오류, 변경값 누락 또는 중복 상세 번호(INVALID_REQUEST).',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({
    description: '주문·통화 또는 해당 주문의 상세가 없음(NOT_FOUND).',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      '세션 권한·Origin 오류, 비활성 고객, 발신번호 불일치 또는 PIN 접근 불가(FORBIDDEN).',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      '저장 버전 불일치(VERSION_CONFLICT), 주문·통화 상태 충돌(INVALID_STATE), 결제 승인 진행 중·DB 잠금 대기 2초 초과(REQUEST_IN_PROGRESS).',
    type: ErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    type: ErrorResponseDto,
    description: '관리자 상세 배송비 누락·합계 범위 초과·전달한 총액 불일치.',
  })
  @ApiOkResponse({
    description:
      '저장 후 실제 version. 주문 상태는 유지하며 새 상세 번호·재계산 총액·저장 내용은 주문 상세에서 조회합니다.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(UpdatedOrderDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  update(
    @Req() request: AuthRequest,
    @Param() params: OrderIdParamsDto,
    @Body() input: UpdateOrderDto,
    @Headers('call_session_seq') callSessionSeq?: string,
  ) {
    return this.orders.update(
      request.admin?.adminUserSeq ?? null,
      params.id,
      input,
      request.requestId,
      callSessionSeq,
    );
  }
}
