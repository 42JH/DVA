import {
  Body,
  Controller,
  createParamDecorator,
  ExecutionContext,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import {
  ApiCookieAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import { AuthRequest } from '../auth/auth.guard';

import { AuditOperation } from '../audit/audit-operation';

import { ErrorResponseDto } from '../common/dto/api-response.dto';

import { MembersService } from './members.service';

import { CreateMemberDto, ListMembersQueryDto, MemberIdParamsDto } from './dto/member-request.dto';

import { MembersEnvelopeDto } from './dto/member-response.dto';

const CreationKey = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  context.switchToHttp().getRequest<AuthRequest>().get('Idempotency-Key'),
);

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

  @Post('companies/:id/members')
  @HttpCode(204)
  @AuditOperation({ action: 'MEMBERSHIP_CREATED', targetType: 'MEMBERSHIP', target: 'none' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOperation({
    summary: '기존 고객을 기업 구성원으로 등록',
    description: 'ACTIVE 고객과 기업만 허용. 같은 고객을 다른 기업으로 자동 이동하지 않습니다.',
  })
  @ApiNoContentResponse()
  create(
    @Param() params: MemberIdParamsDto,
    @CreationKey(new ParseUUIDPipe()) key: string,
    @Body() input: CreateMemberDto,
    @Req() request: AuthRequest,
  ) {
    return this.members.create(
      params.id,
      input,
      request.admin.adminUserSeq,
      key.toLowerCase(),
      request.requestId,
    );
  }
}
