import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthRequest, MvpAiCustomerAccess } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CustomersService } from './customers.service';
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
  @MvpAiCustomerAccess()
  @ApiOperation({
    summary: '고객 등록',
    security: [],
    description:
      'MVP에서는 서비스 인증 없음(후속 Jira 135). 신규 상태 ACTIVE. 이미 등록된 전화번호는 409 DUPLICATE_RESOURCE를 반환합니다.',
  })
  @ApiCreatedResponse({ type: CreatedCustomerEnvelopeDto })
  create(@Body() input: CreateCustomerDto) {
    return this.customers.create(input);
  }

  @Get(':id')
  @MvpAiCustomerAccess()
  @ApiOperation({
    summary: '고객 상세',
    security: [],
    description:
      'MVP 서비스 인증 없음. WITHDRAWN 고객은 ACTIVE 관리자 세션에만 노출됩니다. 통화 고객 범위 검증은 아직 제공하지 않습니다.',
  })
  @ApiOkResponse({ type: CustomerEnvelopeDto })
  find(@Param() params: CustomerIdParamsDto, @Req() request: AuthRequest) {
    return this.customers.find(params.id, Boolean(request.admin));
  }

  @Patch(':id')
  @MvpAiCustomerAccess()
  @HttpCode(204)
  @ApiOperation({
    summary: '고객 이름·상태 변경',
    security: [{ adminSession: [] }, {}],
    description:
      '이름 수정은 MVP 서비스 인증 없음. status는 ACTIVE 관리자 세션과 허용 Origin 필수. 전화번호 변경·탈퇴 복구는 지원하지 않습니다.',
  })
  @ApiNoContentResponse()
  update(
    @Param() params: CustomerIdParamsDto,
    @Body() input: UpdateCustomerDto,
    @Req() request: AuthRequest,
  ) {
    return this.customers.update(params.id, input, Boolean(request.admin));
  }
}
