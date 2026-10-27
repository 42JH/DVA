import {
  Body,
  Headers,
  Controller,
  Post,
  Patch,
  Get,
  Query,
  Param,
  Req,
  Res,
  createParamDecorator,
  ExecutionContext,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiExtraModels,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiAcceptedResponse,
  ApiUnprocessableEntityResponse,
  ApiServiceUnavailableResponse,
  ApiHeader,
  ApiOperation,
  ApiBody,
  getSchemaPath,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { MvpAiOrderAccess } from '../auth/mvp-ai-access';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatedOrderDto, OrderDetailDto, OrderSummaryDto } from './dto/order-response.dto';
import { OrderIdParamsDto, OrderQueryDto } from './dto/order-query.dto';
import { OrdersService } from './orders.service';
import { UpdateOrderDto, UpdatedOrderDto } from './dto/update-order.dto';
import { SubmitOrderDto, SubmittedOrderDto } from './dto/submit-order.dto';

const OrderRequestKey = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Request>().get('Idempotency-Key'),
);

@ApiTags('Orders')
@ApiExtraModels(
  CreateOrderDto,
  CreatedOrderDto,
  OrderSummaryDto,
  OrderDetailDto,
  UpdateOrderDto,
  UpdatedOrderDto,
  SubmitOrderDto,
  SubmittedOrderDto,
  RequestMetaDto,
  ErrorResponseDto,
)
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

  @Get()
  @MvpAiOrderAccess()
  @ApiOperation({
    summary: '주문 목록 조회 (ORD-02)',
    security: [{ adminSession: [] }, {}],
    description:
      '생성 시각·주문 번호 내림차순으로 조회합니다. 필터는 모두 AND 조건이며, 배송 상태는 팀 DB 저장값입니다.\n\n관리자는 전체 주문, AI는 진행 중 통화의 발신번호와 일치하는 활성 고객의 주문만 조회합니다. AI 서비스 인증은 아직 적용되지 않습니다.',
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
      required: ['data', 'hasNext'],
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(OrderSummaryDto) } },
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

  @Post()
  @MvpAiOrderAccess()
  @AuditOperation({ action: 'ORDER_CREATED', targetType: 'ORDER', target: 'none' })
  @ApiOperation({
    summary: '주문 생성 (ORD-01)',
    security: [{ adminSession: [] }, {}],
    description:
      'AI·관리자 공통 API. 부분 입력을 허용하며 모든 주문은 COLLECTING으로 저장합니다. 디버 최종 접수는 별도입니다.\n\n관리자는 로그인 세션, AI는 기존 통화 번호가 필요합니다. AI 서비스 인증은 아직 적용되지 않습니다.',
  })
  @ApiBody({
    description:
      'customerSeq 또는 customer 중 하나로 고객을 지정합니다. 미등록 전화번호는 주문과 함께 고객으로 등록합니다.',
    schema: {
      allOf: [{ $ref: getSchemaPath(CreateOrderDto) }],
      oneOf: [{ required: ['customerSeq'] }, { required: ['customer'] }],
    },
    examples: {
      existingCustomer: {
        summary: '기존 고객 번호로 저장',
        value: { customerSeq: 31, parcels: [] },
      },
      customerByPhone: {
        summary: '전화번호로 고객 연결 또는 신규 등록',
        value: { customer: { name: '예시 고객', phoneNumber: '01012345678' }, parcels: [] },
      },
    },
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    description:
      '주문 생성 UUID. 재시도는 같은 키, 새 주문은 새 키를 사용합니다. 같은 키는 본문 재적용 없이 기존 주문·현재 버전을 반환합니다.',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description: 'DB call_sessions.call_session_seq 값. AI 필수·관리자 선택. 인증 토큰이 아닙니다.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiNotFoundResponse({ description: '고객 또는 통화가 없음.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: '같은 키 처리 중이거나 고객·통화 상태가 주문 생성 조건에 맞지 않음.',
    type: ErrorResponseDto,
  })
  @ApiCreatedResponse({
    description: '주문 번호와 현재 버전. 같은 생성 키를 재시도해도 같은 주문을 반환합니다.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(CreatedOrderDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  create(
    @Req() request: AuthRequest,
    @OrderRequestKey(new ParseUUIDPipe()) key: string,
    @Body() input: CreateOrderDto,
    @Headers('call_session_seq') callSessionSeq?: string,
  ) {
    return this.orders.create(
      request.admin?.adminUserSeq ?? null,
      key.toLowerCase(),
      input,
      request.requestId,
      callSessionSeq,
    );
  }

  @Patch(':id')
  @MvpAiOrderAccess()
  @AuditOperation({ action: 'ORDER_UPDATED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '주문 수집 정보 수정 (ORD-04)',
    security: [{ adminSession: [] }, {}],
    description:
      'AI·관리자 공통 API. COLLECTING 주문만 부분 수정하며 디버에는 전송하지 않습니다. 생략한 값은 유지하고 nullable 필드의 null은 값을 비웁니다.\n\nAI는 발신번호가 일치하는 활성 고객의 주문만 저장합니다. 진행 중 통화는 선택한 주문에 연결하고, 종료된 통화는 기존 연결 주문의 후처리만 허용합니다. AI 서비스 인증은 아직 적용되지 않습니다.',
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
      'expectedVersion과 변경값이 필요합니다. 상세 번호가 없으면 새 상세를 추가합니다. 응답 유실·409 시 최신 상세를 조회해 재판단하며 새 상세를 무조건 재추가하지 않습니다.',
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
      '저장 버전 불일치(VERSION_CONFLICT), 주문·통화 상태 또는 연결 충돌(INVALID_STATE).',
    type: ErrorResponseDto,
  })
  @ApiOkResponse({
    description: '저장 후 실제 version. 새 상세 번호·저장 내용은 ORD-03으로 조회합니다.',
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

  @Post(':id/submit')
  @MvpAiOrderAccess()
  @AuditOperation({ action: 'ORDER_SUBMITTED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '주문 최종 접수 (ORD-06)',
    security: [{ adminSession: [] }, {}],
    description:
      '고객이 확인한 기존 COLLECTING 주문을 검증하고 디버에 한 번 전송합니다. 같은 주문 재호출은 현재 상태만 반환하며 Idempotency-Key는 필요하지 않습니다.\n\n결제: credit은 공통 기본값, groupBilling은 활성 기업 소속 고객, billing은 개인 고객 전용입니다. 주소·물품·미래 수거 시각이 필요합니다.\n\n관리자는 세션, AI는 진행 중 통화와 고객 범위를 확인합니다. AI 서비스 인증은 아직 적용되지 않습니다. 결과가 불명확해도 자동 재접수하지 않습니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    description:
      'DB call_sessions.call_session_seq. AI 필수·관리자 선택. 종료된 통화는 기존 연결 주문의 접수 상태 재확인만 허용.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiBody({
    type: SubmitOrderDto,
    description:
      '고객에게 저장된 주소·물품·결제·수거 시각을 확인한 뒤 호출합니다. 주문 본문은 다시 보내지 않습니다.',
    examples: {
      confirmedVersion: { summary: '최종 확인한 주문 버전 접수', value: { expectedVersion: 4 } },
    },
  })
  @ApiNotFoundResponse({ description: '주문·고객·통화가 없음(NOT_FOUND).', type: ErrorResponseDto })
  @ApiForbiddenResponse({
    description: '고객·통화·PIN 범위 또는 결제 방식 사용 자격 불일치(FORBIDDEN).',
    type: ErrorResponseDto,
  })
  @ApiConflictResponse({
    description:
      '버전 불일치(VERSION_CONFLICT), 접수 불가 상태·통화 연결 충돌(INVALID_STATE), 소속 변경 처리 중(REQUEST_IN_PROGRESS).',
    type: ErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: '필수 주문 정보 오류(VALIDATION_FAILED, details에 필드 경로).',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: '디버 API 키 미설정. 주문은 COLLECTING 유지.',
    type: ErrorResponseDto,
  })
  @ApiOkResponse({
    description:
      '결과 저장 완료. ACCEPTED만 접수 성공이며 AUTH_FAILED·REVIEW_REQUIRED는 확인이 필요합니다. 접수 참고번호·배송은 ORD-03에서 조회합니다.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(SubmittedOrderDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  @ApiAcceptedResponse({
    description:
      'SUBMITTING: 처리 중 또는 결과 저장 미확정. Location의 상세를 조회합니다. 1분 넘게 갱신되지 않은 SUBMITTING은 이 API 재호출 시 REVIEW_REQUIRED로 전환합니다.',
    headers: {
      Location: {
        description: '현재 주문 상세 URL.',
        schema: { type: 'string', example: '/api/orders/123' },
      },
    },
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(SubmittedOrderDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  async submit(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
    @Param() params: OrderIdParamsDto,
    @Body() input: SubmitOrderDto,
    @Headers('call_session_seq') callSessionSeq?: string,
  ) {
    const result = await this.orders.submit(
      request.admin?.adminUserSeq ?? null,
      params.id,
      input,
      request.requestId,
      callSessionSeq,
    );
    response.status(result.status === 'SUBMITTING' ? 202 : 200);
    if (result.status === 'SUBMITTING') response.setHeader('Location', `/api/orders/${params.id}`);
    return result;
  }

  @Get(':id')
  @MvpAiOrderAccess()
  @ApiOperation({
    summary: '주문 상세·배송 상태 조회 (ORD-03)',
    security: [{ adminSession: [] }, {}],
    description:
      '주문에 저장된 주소·물품·배송 정보와 현재 version을 반환합니다. 미수집 값은 null, 상세가 없으면 parcels는 빈 배열입니다. 원본 PIN 변경은 주문 주소에 반영하지 않습니다.\n\nAI는 발신번호가 일치하는 활성 고객의 주문만 조회합니다. 종료된 통화는 저장 결과 확인을 위해 기존 연결 주문 한 건만 조회할 수 있습니다. AI 서비스 인증과 택배사 실시간 조회는 적용되지 않습니다.',
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
