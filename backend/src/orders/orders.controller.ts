import {
  Body,
  Headers,
  Controller,
  Post,
  Req,
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
  ApiHeader,
  ApiOperation,
  ApiBody,
  getSchemaPath,
} from '@nestjs/swagger';
import { Request } from 'express';
import { MvpAiOrderIntake } from '../auth/mvp-ai-access';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreatedOrderDto } from './dto/order-response.dto';
import { OrdersService } from './orders.service';

const CreationKey = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Request>().get('Idempotency-Key'),
);

@ApiTags('Orders')
@ApiExtraModels(CreateOrderDto, CreatedOrderDto, RequestMetaDto, ErrorResponseDto)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @MvpAiOrderIntake()
  @AuditOperation({ action: 'ORDER_CREATED', targetType: 'ORDER', target: 'none' })
  @ApiOperation({
    summary: 'ORD-01 주문 생성',
    security: [{ adminSession: [] }, {}],
    description:
      'AI와 관리자가 같은 경로를 사용합니다. AI는 기존 통화 ID(X-Call-Session-Id), 관리자는 활성 세션을 사용합니다. customerSeq 또는 customer 중 하나로 고객을 연결·등록합니다. 정보가 모두 있어도 COLLECTING이며 ORD-04/06은 같은 orderSeq를 이어받습니다. AI 서비스 인증은 MVP 이후 Jira 135 범위입니다.',
  })
  @ApiBody({
    schema: {
      allOf: [{ $ref: getSchemaPath(CreateOrderDto) }],
      oneOf: [{ required: ['customerSeq'] }, { required: ['customer'] }],
    },
    examples: {
      existingCustomer: {
        summary: '기존 고객 ID로 저장 (실제 ID로 변경)',
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
      '생성 요청 UUID. 같은 키는 기존 주문과 현재 버전을 반환하며 본문을 다시 적용하지 않습니다. 새 주문은 새 키를 사용합니다.',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiHeader({
    name: 'X-Call-Session-Id',
    required: false,
    description:
      'AI 호출 시 필수인 기존 callSessionSeq. 관리자 호출 시 선택. 통화 ID 자체는 인증 수단이 아닙니다.',
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiCreatedResponse({
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
    @CreationKey(new ParseUUIDPipe()) key: string,
    @Body() input: CreateOrderDto,
    @Headers('x-call-session-id') callSessionId?: string,
  ) {
    return this.orders.create(
      request.admin?.adminUserSeq ?? null,
      key.toLowerCase(),
      input,
      request.requestId,
      callSessionId,
    );
  }
}
