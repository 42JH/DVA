import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthRequest, MvpAiCustomerAccess } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CustomersService } from './customers.service';
import { AuditOperation } from '../audit/audit-operation';
import { CallerContextEnvelopeDto, CallerContextRequestDto } from './dto/caller-context.dto';
import {
  CreateCustomerDto,
  CustomerIdParamsDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './dto/customer-request.dto';
import {
  CreatedCustomerEnvelopeDto,
  CustomerEnvelopeDto,
  CustomersEnvelopeDto,
} from './dto/customer-response.dto';

@ApiTags('Customers')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post('context')
  @HttpCode(200)
  @MvpAiCustomerAccess()
  @ApiOperation({
    summary: '고객 확인·주소록 조회 및 유효 상담 통화 등록',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      'AI_BUSINESS_TOKEN의 Bearer 인증 또는 ACTIVE 관리자 세션이 필요합니다. 첫 고객 확인은 phoneNumber만 보내며 통화·감사를 저장하지 않습니다. AI가 주문 접수·접수 조회·FAQ·상담원 연결 등 업무 의도를 확인한 뒤 같은 API에 call을 포함하면 통화를 생성·재사용하고 callSessionSeq를 반환합니다. 최초 providerCallId·incomingAt을 유지하고, 응답 번호를 주문 조회·취소·주소록 API의 call_session_seq 헤더에 사용합니다. 무의미 통화는 등록·업무 결과 전송을 생략합니다. 같은 통화 ID의 발신번호·수신 시각이 다르면 409입니다. 고객·주문은 생성하지 않습니다.',
  })
  @ApiOkResponse({ type: CallerContextEnvelopeDto })
  context(@Body() input: CallerContextRequestDto, @Req() request: AuthRequest) {
    return this.customers.context(input, request.admin?.adminUserSeq ?? null, request.requestId);
  }

  @Get()
  @ApiCookieAuth('adminSession')
  @ApiOperation({
    summary: '고객 목록',
    description: '모든 ACTIVE 관리자. 고객 번호 내림차순. AI 초기 데이터 조회는 별도 API입니다.',
  })
  @ApiOkResponse({ type: CustomersEnvelopeDto })
  list(@Query() query: ListCustomersQueryDto) {
    return this.customers.list(query);
  }

  @Post()
  @AuditOperation({ action: 'CUSTOMER_CREATED', targetType: 'CUSTOMER', target: 'none' })
  @MvpAiCustomerAccess()
  @ApiOperation({
    summary: '고객 등록',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      'AI_BUSINESS_TOKEN의 Bearer 인증 또는 ACTIVE 관리자 세션이 필요합니다. 신규 상태 ACTIVE. 이미 등록된 전화번호는 409 DUPLICATE_RESOURCE를 반환합니다. 월결제 자격 설정은 관리자 전용입니다.',
  })
  @ApiCreatedResponse({ type: CreatedCustomerEnvelopeDto })
  create(@Body() input: CreateCustomerDto, @Req() request: AuthRequest) {
    return this.customers.create(input, request.admin?.adminUserSeq ?? null, request.requestId);
  }

  @Get(':id')
  @MvpAiCustomerAccess()
  @ApiOperation({
    summary: '고객 상세',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      'AI_BUSINESS_TOKEN의 Bearer 인증 또는 ACTIVE 관리자 세션이 필요합니다. WITHDRAWN 고객은 ACTIVE 관리자 세션에만 노출됩니다. 서비스 인증과 별개로 상세 조회의 통화 고객 범위 검증은 아직 제공하지 않습니다.',
  })
  @ApiOkResponse({ type: CustomerEnvelopeDto })
  find(@Param() params: CustomerIdParamsDto, @Req() request: AuthRequest) {
    return this.customers.find(params.id, Boolean(request.admin));
  }

  @Patch(':id')
  @AuditOperation({ action: 'CUSTOMER_UPDATED', targetType: 'CUSTOMER', target: 'id' })
  @MvpAiCustomerAccess()
  @HttpCode(204)
  @ApiOperation({
    summary: '고객 이름·상태 변경',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      'AI는 AI_BUSINESS_TOKEN의 Bearer 인증이 필요합니다. 내 주소 수정·삭제는 call_session_seq로 진행 중인 본인 통화도 확인합니다. 관리자는 통화 헤더 없이 기존 세션과 허용 Origin으로 수정합니다. status·월결제 자격은 관리자 전용이며 전화번호 변경·탈퇴 복구는 지원하지 않습니다.',
  })
  @ApiHeader({
    name: 'call_session_seq',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
    description:
      'AI가 address를 수정·삭제할 때 필수. 진행 중 본인 통화 번호. 관리자와 AI 이름 단독 수정에는 불필요.',
  })
  @ApiNoContentResponse()
  update(
    @Param() params: CustomerIdParamsDto,
    @Body() input: UpdateCustomerDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.customers.update(
      params.id,
      input,
      request.admin?.adminUserSeq ?? null,
      request.requestId,
      header,
    );
  }
}
