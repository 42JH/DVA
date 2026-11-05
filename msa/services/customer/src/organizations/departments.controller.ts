import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { OrganizationIdParamsDto } from './dto/organization-id-params.dto';
import { DepartmentsEnvelopeDto } from './dto/department.dto';
import { DepartmentsService } from './departments.service';
import { ErrorResponseDto } from '../common/dto/api-response.dto';

@ApiTags('departments')
@ApiCookieAuth('adminSession')
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiUnauthorizedResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller()
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}
  @Get('companies/:id/departments')
  @ApiOperation({ summary: '기업 부서 목록' })
  @ApiOkResponse({ type: DepartmentsEnvelopeDto })
  list(@Param() params: OrganizationIdParamsDto, @Query() query: PaginationQueryDto) {
    return this.departments.list(params.id, query);
  }
}
