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

@ApiTags('주문')
@ApiExtraModels(CreateOrderDto, CreatedOrderDto, RequestMetaDto, ErrorResponseDto)
@ApiBadRequestResponse({
  description: '요청 본문·생성 키·통화 번호 형식 오류 또는 필수 값 누락.',
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

  @Post()
  @MvpAiOrderIntake()
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
    name: 'X-Call-Session-Id',
    required: false,
    description: '기존 통화 번호(callSessionSeq). AI 필수·관리자 선택. 인증 토큰이 아닙니다.',
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
    @CreationKey(new ParseUUIDPipe()) key: string,
    @Body() input: CreateOrderDto,
    @Headers('X-Call-Session-Id') callSessionId?: string,
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
