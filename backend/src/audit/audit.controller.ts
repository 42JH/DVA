import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './dto/audit-query.dto';
import { AuditDetailResponseDto, AuditListResponseDto } from './dto/audit-response.dto';
import { AuditIdParamsDto } from './dto/audit-id-params.dto';

@ApiTags('Audit')
@ApiCookieAuth('adminSession')
@ApiResponse({
  status: 400,
  description: '조회 조건 또는 식별자 형식 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '로그인 세션이 없거나 만료됨.', type: ErrorResponseDto })
@ApiResponse({
  status: 403,
  description: 'OPERATOR 또는 SYSTEM_ADMIN 권한 필요.',
  type: ErrorResponseDto,
})
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({
    summary: '감사 기록 목록 조회',
    description:
      'OPERATOR·SYSTEM_ADMIN 전용. 작업자·작업·대상·결과·기간으로 필터링하며 최신 기록부터 조회합니다.',
  })
  @ApiQuery({ name: 'limit', required: false, description: '조회 개수. 기본 20, 최대 100.' })
  @ApiQuery({ name: 'offset', required: false, description: '건너뛸 개수. 기본 0.' })
  @ApiOkResponse({ description: '감사 기록 목록과 다음 페이지 여부.', type: AuditListResponseDto })
  findMany(@Query() query: AuditQueryDto) {
    return this.audit.findMany(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: '감사 기록 상세 조회',
    description:
      'OPERATOR·SYSTEM_ADMIN 전용. 감사 기록 한 건의 작업자·대상·결과·발생 시각을 조회합니다.',
  })
  @ApiOkResponse({ description: '감사 기록 상세.', type: AuditDetailResponseDto })
  @ApiResponse({ status: 404, description: '대상 감사 기록이 없음.', type: ErrorResponseDto })
  findOne(@Param() params: AuditIdParamsDto) {
    return this.audit.findOne(params.id);
  }
}
