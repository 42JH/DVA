import { Body, Res, ParseUUIDPipe } from '@nestjs/common';
import type { Response } from 'express';
import { CreateManualOrderDto, ManualOrderResultDto } from './dto/manual-order.dto';
import { OrderRequestKey } from './order-request-key';
import { ApiException } from '../common/errors/api.exception';
import {
  ApiHeader,
  ApiBody,
  ApiCreatedResponse,
  ApiAcceptedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiUnprocessableEntityResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
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

@ApiExtraModels(CreateManualOrderDto, ManualOrderResultDto, RequestMetaDto)
@ApiTags('Admin Orders')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SYSTEM_ADMIN')
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

  @Post()
  @AuditOperation({ action: 'ORDER_CREATED', targetType: 'ORDER', target: 'none' })
  @ApiOperation({
    summary: '관리자 수기 주문 접수',
    description:
      '활성 관리자 세션과 허용 Origin 필수. 완성된 주문을 검증·저장합니다. 개인 카드는 결제를 대기하고 월·그룹결제는 즉시 결제 완료 후 디버에 접수합니다. 통화 정보·outcome은 받지 않습니다. ACCEPTED만 접수 성공이며 실패 주문은 관리자 재접수 API를 사용합니다. 같은 UUID는 최초 생성자에게 현재 결과만 반환합니다.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description:
      '주문 의도별 UUID. 전송 전에 보관하고 재시도에도 같은 키 사용. 본문 재적용·디버 재전송 없음.',
  })
  @ApiBody({
    schema: {
      allOf: [{ $ref: getSchemaPath(CreateManualOrderDto) }],
      oneOf: [{ required: ['customerSeq'] }, { required: ['customer'] }],
    },
    description:
      'customerSeq 또는 customer 중 하나와 완성된 택배 상세. 요청 수거 시각은 그 시각까지 결제하면 유지하며, 이후 결제 또는 생략 시 결제 완료 + 1시간을 한국시간 09:00~17:00으로 조정합니다. totalAmount와 각 parcels[].notifiedPrice를 전달하며 미취소 상세 합계를 검증합니다.',
  })
  @ApiCreatedResponse({
    description: '현재 접수 결과. HTTP 201만으로 성공을 판단하지 않습니다.',
    schema: {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { $ref: getSchemaPath(ManualOrderResultDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  @ApiAcceptedResponse({
    description: 'SUBMITTING: 처리 중 또는 결과 저장 미확정. 같은 키로 재확인.',
    schema: {
      type: 'object',
      properties: {
        data: { $ref: getSchemaPath(ManualOrderResultDto) },
        meta: { $ref: getSchemaPath(RequestMetaDto) },
      },
    },
  })
  @ApiBadRequestResponse({
    description: '키·본문 형식 오류, 추가 필드 또는 통화 헤더 전달.',
    type: ErrorResponseDto,
  })
  @ApiUnauthorizedResponse({
    description: '관리자 로그인 세션 없음·만료·비활성 계정.',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Origin·권한·고객/PIN/결제 자격 또는 요청 키 소유자 불일치.',
    type: ErrorResponseDto,
  })
  @ApiNotFoundResponse({ description: '고객 없음.', type: ErrorResponseDto })
  @ApiConflictResponse({
    description: '중복 요청 처리 중, 고객 상태 충돌 또는 수기 주문이 아닌 요청 키.',
    type: ErrorResponseDto,
  })
  @ApiUnprocessableEntityResponse({
    description: '완성 주문의 필수 주소·물품 미충족. 저장·외부 호출 없음.',
    type: ErrorResponseDto,
  })
  @ApiServiceUnavailableResponse({
    description: '디버 접수 설정 누락. 저장·외부 호출 없음.',
    type: ErrorResponseDto,
  })
  async create(
    @Req() request: AuthRequest,
    @Res({ passthrough: true }) response: Response,
    @OrderRequestKey(new ParseUUIDPipe()) key: string,
    @Body() input: CreateManualOrderDto,
  ) {
    if (request.get('call_session_seq') !== undefined)
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '수기 주문에는 통화 헤더를 전달하지 않습니다.',
      );
    const result = await this.orders.createManual(
      request.admin.adminUserSeq,
      key.toLowerCase(),
      input,
      request.requestId,
    );
    response.location(`/api/orders/${result.orderSeq}`);
    if (result.status === 'SUBMITTING') response.status(202);
    return result;
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
