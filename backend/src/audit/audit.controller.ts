import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditDetailResponseDto, AuditListResponseDto } from './dto/audit-response.dto';
import { AuditIdParamsDto } from './dto/audit-id-params.dto';

@ApiTags('Audit')
@ApiCookieAuth('adminSession')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@Roles('SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: '관리자 작업 감사 로그 목록 조회' })
  @ApiOkResponse({ type: AuditListResponseDto })
  findMany(@Query() query: AuditQueryDto) {
    return this.audit.findMany(query);
  }

  @Get(':id')
  @ApiOperation({ summary: '관리자 작업 감사 로그 상세 조회' })
  @ApiOkResponse({ type: AuditDetailResponseDto })
  @ApiResponse({ status: 404, type: ErrorResponseDto })
  findOne(@Param() params: AuditIdParamsDto) {
    return this.audit.findOne(params.id);
  }
}
