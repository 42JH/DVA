import {
  Body,
  Controller,
  Get,
  createParamDecorator,
  ExecutionContext,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
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
import { Request } from 'express';
import { AuthRequest } from '../auth/auth.guard';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import { CreatedOrganizationDto, OrganizationResponseDto } from './dto/organization-response.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { OrganizationsService } from './organizations.service';
import { AuditOperation } from '../audit/audit-operation';

const single = (model: typeof CreatedOrganizationDto) => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: { $ref: getSchemaPath(model) },
    meta: { $ref: getSchemaPath(RequestMetaDto) },
  },
});

const CreationKey = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Request>().get('Idempotency-Key'),
);

@ApiTags('Companies')
@ApiCookieAuth('adminSession')
@ApiExtraModels(CreatedOrganizationDto, OrganizationResponseDto, RequestMetaDto, ErrorResponseDto)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('companies')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

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
    description: '모든 활성 관리자. 신규 기업 상태는 ACTIVE입니다.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({ schema: single(CreatedOrganizationDto) })
  @ApiConflictResponse({ type: ErrorResponseDto })
  @ApiUnprocessableEntityResponse({ type: ErrorResponseDto })
  create(
    @Req() request: AuthRequest,
    @CreationKey(new ParseUUIDPipe()) key: string,
    @Body() input: CreateOrganizationDto,
  ) {
    return this.organizations.create(
      request.admin.adminUserSeq,
      key.toLowerCase(),
      input,
      request.requestId,
    );
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
