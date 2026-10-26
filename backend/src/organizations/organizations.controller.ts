import {
  Body,
  Controller,
  Get,
  createParamDecorator,
  ExecutionContext,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiHeader,
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
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import { CreatedOrganizationDto, OrganizationResponseDto } from './dto/organization-response.dto';
import { OrganizationsService } from './organizations.service';

const single = (model: typeof CreatedOrganizationDto) => ({
  type: 'object',
  required: ['data', 'meta'],
  properties: {
    data: { $ref: getSchemaPath(model) },
    meta: { $ref: getSchemaPath(RequestMetaDto) },
  },
});

// Issue 83 supplies the session-authenticated identity before this module is registered in AppModule.
type OrganizationAdminRequest = Request & { user: { adminUserSeq: number } };

const CreationKey = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<Request>().get('Idempotency-Key'),
);

@ApiTags('Companies')
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
    @Req() request: OrganizationAdminRequest,
    @CreationKey(new ParseUUIDPipe()) key: string,
    @Body() input: CreateOrganizationDto,
  ) {
    return this.organizations.create(request.user.adminUserSeq, key.toLowerCase(), input);
  }

  @Get(':id')
  @ApiOperation({ summary: '기업 상세' })
  @ApiOkResponse({ schema: single(OrganizationResponseDto) })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  find(@Param() params: OrganizationIdParamsDto) {
    return this.organizations.find(params.id);
  }
}
