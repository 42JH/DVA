import {
  Body,
  Controller,
  Post,
  Req,
  createParamDecorator,
  ExecutionContext,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiCookieAuth,
  ApiExtraModels,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiUnprocessableEntityResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiBody,
  getSchemaPath,
} from '@nestjs/swagger';
import { Request } from 'express';
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
@ApiCookieAuth('adminSession')
@ApiExtraModels(CreateOrderDto, CreatedOrderDto, RequestMetaDto, ErrorResponseDto)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  @AuditOperation({ action: 'ORDER_CREATED', targetType: 'ORDER', target: 'none' })
  @ApiOperation({
    summary: '미완료 주문 생성',
    description:
      '활성 관리자 세션. customerSeq 또는 customer(이름·전화번호) 중 하나를 전달합니다. 미등록 전화번호면 고객과 주문을 함께 생성합니다. 정보가 모두 있어도 COLLECTING으로 저장하며 최종 접수는 별도입니다. AI 서비스 인증은 아직 지원하지 않습니다.',
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
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto })
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
  ) {
    return this.orders.create(
      request.admin.adminUserSeq,
      key.toLowerCase(),
      input,
      request.requestId,
    );
  }
}
