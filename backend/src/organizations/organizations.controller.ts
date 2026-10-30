import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { AuthRequest } from '../auth/auth.guard';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import { CreatedOrganizationDto, OrganizationResponseDto } from './dto/organization-response.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';
import { AuditOperation } from '../audit/audit-operation';
import { MvpAiDirectoryAccess } from '../auth/mvp-ai-access';
import { CompanyDirectoryEnvelopeDto, CompanyDirectoryQueryDto } from './dto/company-directory.dto';
import { OrganizationBillingService } from './organization-billing.service';
import { BillingMonthQueryDto, BillingMonthEnvelopeDto } from './dto/billing-month.dto';

const single = (model: typeof CreatedOrganizationDto) => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: { $ref: getSchemaPath(model) },
    meta: { $ref: getSchemaPath(RequestMetaDto) },
  },
});

@ApiTags('Companies')
@ApiCookieAuth('adminSession')
@ApiExtraModels(CreatedOrganizationDto, OrganizationResponseDto, RequestMetaDto, ErrorResponseDto)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('companies')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly billing: OrganizationBillingService,
  ) {}

  @Get(':id/billing')
  @ApiOperation({ summary: '기업 월결제·그룹결제 월별 사용액 조회' })
  @ApiOkResponse({ type: BillingMonthEnvelopeDto })
  billingMonth(@Param() params: OrganizationIdParamsDto, @Query() query: BillingMonthQueryDto) {
    return this.billing.read(params.id, query.month);
  }

  // 정적 경로를 :id보다 먼저 등록하여 search를 기업 번호로 해석하지 않는다.
  @Get('search')
  @MvpAiDirectoryAccess()
  @ApiOperation({
    summary: '기업 공식 배송지 검색 (DIR-01)',
    security: [{ adminSession: [] }, {}],
    description:
      '활성 기업의 공유 PIN 전체를 공식 공개 배송지로 검색합니다. 기업명과 PIN의 부서·수령인·연락처·주소만 제공하며 구성원·개인 PIN은 조회하지 않습니다. MVP AI 서비스 인증·통화 헤더는 요구하지 않습니다.',
  })
  @ApiOkResponse({ type: CompanyDirectoryEnvelopeDto })
  search(@Query() query: CompanyDirectoryQueryDto) {
    return this.organizations.searchDirectory(query);
  }

  @Get()
  @ApiOperation({
    summary: '기업 목록',
    description: '모든 활성 관리자. 기업 번호 내림차순으로 조회합니다.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['data', 'hasNext'],
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(OrganizationResponseDto) } },
        hasNext: { type: 'boolean' },
      },
    },
  })
  list(@Query() query: ListOrganizationsQueryDto) {
    return this.organizations.list(query);
  }

  @Post()
  @AuditOperation({ action: 'ORGANIZATION_CREATED', targetType: 'ORGANIZATION', target: 'none' })
  @ApiOperation({
    summary: '기업 등록',
    description:
      '모든 활성 관리자. 신규 기업 상태는 ACTIVE입니다. 동일 기업명은 허용하며 등록 요청을 자동 재시도하지 않습니다.',
  })
  @ApiCreatedResponse({ schema: single(CreatedOrganizationDto) })
  create(@Req() request: AuthRequest, @Body() input: CreateOrganizationDto) {
    return this.organizations.create(request.admin.adminUserSeq, input, request.requestId);
  }

  @Get(':id')
  @ApiOperation({ summary: '기업 상세' })
  @ApiOkResponse({ schema: single(OrganizationResponseDto) })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  find(@Param() params: OrganizationIdParamsDto) {
    return this.organizations.find(params.id);
  }

  @Patch(':id')
  @AuditOperation({ action: 'ORGANIZATION_UPDATED', targetType: 'ORGANIZATION', target: 'id' })
  @HttpCode(204)
  @ApiOperation({
    summary: '기업명·상태 변경',
    description: 'INACTIVE 전환은 구성원·PIN을 삭제하지 않습니다.',
  })
  @ApiNoContentResponse({ description: '저장 완료. 응답 본문 없음.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async update(
    @Param() params: OrganizationIdParamsDto,
    @Body() changes: UpdateOrganizationDto,
    @Req() request: AuthRequest,
  ) {
    await this.organizations.update(
      params.id,
      changes,
      request.admin.adminUserSeq,
      request.requestId,
    );
  }
}
