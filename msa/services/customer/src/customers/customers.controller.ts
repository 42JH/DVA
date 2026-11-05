import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { type AuthRequest, MvpAiCustomerAccess } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CustomersService } from './customers.service';
import { CustomerIdParamsDto, ListCustomersQueryDto } from './dto/customer-request.dto';
import { CustomerEnvelopeDto, CustomersEnvelopeDto } from './dto/customer-response.dto';

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
}
