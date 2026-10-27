import { Controller, Get, Param, Query } from '@nestjs/common';

import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ErrorResponseDto } from '../common/dto/api-response.dto';

import { MembersService } from './members.service';

import { ListMembersQueryDto, MemberIdParamsDto } from './dto/member-request.dto';

import { MembersEnvelopeDto } from './dto/member-response.dto';

@ApiTags('Members')
@ApiCookieAuth('adminSession')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 422, type: ErrorResponseDto })
@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('companies/:id/members')
  @ApiOperation({
    summary: '기업 구성원 목록',
    description: '모든 ACTIVE 관리자. 대표자 표시는 관리자 웹 권한과 무관합니다.',
  })
  @ApiOkResponse({ type: MembersEnvelopeDto })
  list(@Param() params: MemberIdParamsDto, @Query() query: ListMembersQueryDto) {
    return this.members.list(params.id, query);
  }
}
