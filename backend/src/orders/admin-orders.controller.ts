import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiOkResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { ApiException } from '../common/errors/api.exception';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { CreateManualOrderDto, ManualOrderResultDto } from './dto/manual-order.dto';
import { OrdersService } from './orders.service';
import { OrderRequestKey } from './order-request-key';
import { OrderIdParamsDto } from './dto/order-query.dto';
import { SubmittedOrderDto } from './dto/submit-order.dto';

@ApiTags('Admin Orders')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiExtraModels(CreateManualOrderDto, ManualOrderResultDto, RequestMetaDto)
@Controller('admin/orders')
export class AdminOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post(':id/retry')
  @HttpCode(200)
  @AuditOperation({ action: 'ORDER_RESUBMISSION_STARTED', targetType: 'ORDER', target: 'id' })
  @ApiOperation({
    summary: '디버 접수 실패 주문 재접수',
    description:
      '결제된 같은 주문의 미취소 상세를 재전송합니다. 결제·월별 사용액을 다시 처리하지 않습니다. 처리 중·완료 주문은 현재 상태만 반환합니다.',
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
    return this.orders.retry(params.id, request.admin!.adminUserSeq, request.requestId);
  }

  @Post()
  @AuditOperation({ action: 'ORDER_CREATED', targetType: 'ORDER', target: 'none' })
  @ApiOperation({
    summary: '관리자 수기 주문 접수',
    description:
      '활성 관리자 세션과 허용 Origin 필수. 완성된 주문을 검증·저장하고 디버에 한 번 접수합니다. 통화 정보·outcome은 받지 않습니다. ACCEPTED만 접수 성공이며 결과가 불명확하면 재접수하지 않습니다. 같은 UUID는 최초 생성자에게 현재 결과만 반환합니다.',
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
      'customerSeq 또는 customer 중 하나와 완성된 택배 상세·미래 수거 시각. 택배 상세별 배송비 3,500원은 서버 지정.',
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
    description: '완성 주문의 필수 주소·물품·미래 수거 시각 미충족. 저장·외부 호출 없음.',
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
}
