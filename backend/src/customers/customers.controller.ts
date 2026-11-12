import {
  Body,
  Controller,
  Delete,
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
import { DeleteCustomersDto } from './dto/delete-customers.dto';
import { BillingMonthQueryDto } from '../organizations/dto/billing-month.dto';
import { CustomerBillingMonthEnvelopeDto } from './dto/customer-billing-month.dto';
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

  @Get(':id/billing')
  @ApiCookieAuth('adminSession')
  @ApiOperation({
    summary: '고객 개인 월결제 사용액 조회',
    description:
      '모든 ACTIVE 관리자. 결제 확정 시각의 한국 시간 월을 기준으로 개인 월결제 원금만 합산합니다. month 생략 시 한국 시간 이번 달입니다.',
  })
  @ApiOkResponse({ type: CustomerBillingMonthEnvelopeDto })
  billingMonth(@Param() params: CustomerIdParamsDto, @Query() query: BillingMonthQueryDto) {
    return this.customers.billingMonth(params.id, query.month);
  }

  @Delete()
  @HttpCode(204)
  @ApiCookieAuth('adminSession')
  @AuditOperation({ action: 'CUSTOMER_DELETED', targetType: 'CUSTOMER', target: 'none' })
  @ApiOperation({
    summary: '고객 단건·다건 soft delete',
    description:
      '모든 ACTIVE 관리자 세션·허용 Origin 전용. customerSeqs 배열 1~100개. 고객과 소속·개인 PIN을 soft delete하며 주문·통화·결제 이력은 보존합니다. 미존재·기삭제가 있거나 감사 저장에 실패하면 전체 롤백합니다. 잠금 경합은 409입니다.',
  })
  @ApiNoContentResponse({ description: '전체 삭제 완료. 응답 본문 없음.' })
  removeMany(@Body() input: DeleteCustomersDto, @Req() request: AuthRequest) {
    return this.customers.removeMany(
      input.customerSeqs,
      request.admin.adminUserSeq,
      request.requestId,
    );
  }

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
    description:
      '모든 ACTIVE 관리자. 고객 번호 내림차순. availablePaymentMethods는 고객 확인 API와 동일한 현재 결제 가능 수단이며 탈퇴 고객은 빈 배열입니다. 실제 주문·결제 시 자격은 다시 확인합니다. AI 초기 데이터 조회는 별도 API입니다.',
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
      'AI_BUSINESS_TOKEN의 Bearer 인증 또는 ACTIVE 관리자 세션이 필요합니다. 이름·전화번호·주소가 필수이며 상세주소는 선택입니다. 신규 상태 ACTIVE. 이미 등록된 전화번호는 409 DUPLICATE_RESOURCE를 반환합니다. 월결제 자격 설정은 관리자 전용입니다.',
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
      'AI는 AI_BUSINESS_TOKEN의 Bearer 인증이 필요합니다. 내 주소 수정·삭제는 call_session_seq로 진행 중인 본인 통화도 확인합니다. 관리자는 통화 헤더 없이 기존 세션과 허용 Origin으로 수정합니다. status·월결제 자격은 관리자 전용입니다. WITHDRAWN을 지정하면 고객과 소속·주소록·등록 카드를 소프트 삭제하고 승인 전 결제 링크를 닫습니다.',
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
