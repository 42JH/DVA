import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
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
  ApiUnprocessableEntityResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { AuthRequest } from '../auth/auth.guard';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import { CreatedOrganizationDto, OrganizationSummaryDto } from './dto/organization-response.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';
import { CreateOrganizationPipe } from './create-organization.pipe';
import { AuditOperation } from '../audit/audit-operation';
import { MvpAiDirectoryAccess } from '../auth/mvp-ai-access';
import { CompanyDirectoryEnvelopeDto, CompanyDirectoryQueryDto } from './dto/company-directory.dto';
import { OrganizationBillingService } from './organization-billing.service';
import { OrganizationDeletionService } from './organization-deletion.service';
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
@ApiExtraModels(CreatedOrganizationDto, OrganizationSummaryDto, RequestMetaDto, ErrorResponseDto)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('companies')
export class OrganizationsController {
  constructor(
    private readonly organizations: OrganizationsService,
    private readonly billing: OrganizationBillingService,
    private readonly deletion: OrganizationDeletionService,
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
      '활성 기업·활성 소속·활성 고객의 현재 기본 주소를 기업 간 공유 배송지로 검색합니다. 사번·역할·개인 PIN은 제공하지 않습니다. MVP AI 서비스 인증·통화 헤더는 요구하지 않습니다.',
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
      required: ['data', 'hasNext', 'total_count'],
      properties: {
        data: { type: 'array', items: { $ref: getSchemaPath(OrganizationSummaryDto) } },
        total_count: { type: 'integer', minimum: 0, description: '검색·필터 후 전체 건수.' },
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
      '모든 활성 관리자. 신규 기업 상태는 ACTIVE입니다. 선택 departments·members를 보내면 기업·부서·고객·사원·성공 감사를 하나의 트랜잭션으로 저장하거나 전체 롤백합니다. 사원의 departmentName은 같은 요청의 부서명이며 부서 없이도 등록할 수 있습니다. JSON 최대 1MiB, 부서·사원 각각 최대 1,000건. 동일 기업명은 허용하며 등록 요청을 자동 재시도하지 않습니다.',
  })
  @ApiBody({ type: CreateOrganizationDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto })
  @ApiCreatedResponse({ schema: single(CreatedOrganizationDto) })
  create(@Req() request: AuthRequest, @Body(new CreateOrganizationPipe()) input: unknown) {
    return this.organizations.create(
      request.admin.adminUserSeq,
      input as CreateOrganizationDto,
      request.requestId,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: '기업 상세' })
  @ApiOkResponse({ schema: single(OrganizationSummaryDto) })
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

  @Delete(':id')
  @HttpCode(204)
  @AuditOperation({ action: 'ORGANIZATION_DELETED', targetType: 'ORGANIZATION', target: 'id' })
  @ApiOperation({
    summary: '기업 삭제',
    description:
      '모든 활성 관리자. 기업·소속·부서·기업 PIN을 하나의 트랜잭션에서 soft delete합니다. 개인 회원·개인 PIN·주문·통화·녹취·과거 청구 총액은 각각의 보관 기준을 유지합니다. 삭제한 기준 정보는 5년 후 실제 폐기합니다.',
  })
  @ApiNoContentResponse({ description: '삭제 완료. 응답 본문 없음.' })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  remove(@Param() params: OrganizationIdParamsDto, @Req() request: AuthRequest) {
    return this.deletion.remove(params.id, false, request.admin.adminUserSeq, request.requestId);
  }
}
