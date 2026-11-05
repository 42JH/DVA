import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import { CreatedOrganizationDto, OrganizationSummaryDto } from './dto/organization-response.dto';
import { OrganizationsService } from './organizations.service';
import { MvpAiDirectoryAccess } from '../auth/mvp-ai-access';
import { CompanyDirectoryEnvelopeDto, CompanyDirectoryQueryDto } from './dto/company-directory.dto';

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
  constructor(private readonly organizations: OrganizationsService) {}
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
  @Get(':id')
  @ApiOperation({ summary: '기업 상세' })
  @ApiOkResponse({ schema: single(OrganizationSummaryDto) })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  find(@Param() params: OrganizationIdParamsDto) {
    return this.organizations.find(params.id);
  }
}
