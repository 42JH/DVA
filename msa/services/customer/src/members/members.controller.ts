import { MemberSearchEnvelopeDto, SearchMembersQueryDto } from './dto/search-members.dto';
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
  ApiBody,
  ApiExtraModels,
  getSchemaPath,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthRequest } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { MembersService } from './members.service';
import {
  CreateMemberDto,
  CreateMembersDto,
  InlineMemberDto,
  ListMembersQueryDto,
  MemberIdParamsDto,
  UpdateMemberDto,
} from './dto/member-request.dto';
import { MembersEnvelopeDto } from './dto/member-response.dto';

import { CreateMemberPipe } from './create-member.pipe';

@ApiTags('Members')
@ApiExtraModels(CreateMemberDto, CreateMembersDto, InlineMemberDto)
@ApiCookieAuth('adminSession')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({
  status: 409,
  description:
    '등록 중복·비활성 기업/고객 또는 DB 잠금 대기 2초 초과(REQUEST_IN_PROGRESS). 다른 변경은 완료 후 이어서 처리합니다.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 422, type: ErrorResponseDto })
@Controller()
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get('companies/members/search')
  @ApiOperation({
    summary: '관리자 사원 검색',
    description: '모든 ACTIVE 관리자. 주소 없는 사원 포함. 기업명·주소는 검색하지 않습니다.',
  })
  @ApiOkResponse({ type: MemberSearchEnvelopeDto })
  search(@Query() query: SearchMembersQueryDto) {
    return this.members.search(query);
  }

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
  @ApiOperation({
    summary: '기업 직원 단건·복수 JSON 등록',
    description:
      '단건 객체 또는 items 1~1,000건, JSON 최대 1MiB. 기존 고객 번호 또는 사번·이름·전화번호로 등록합니다. 이름·전화번호 형식은 고객 address를 함께 저장하며 생략 시 유지(신규는 null), null로 삭제, 객체는 전체 교체합니다. role은 선택이며 신규 생략은 MEMBER, 기존 직원 갱신에서 생략하면 유지합니다. 부서는 선택입니다. 전체 요청을 함께 저장·롤백하며 다른 기업 소속은 자동 이동하지 않습니다.',
  })
  @ApiNoContentResponse()
  @ApiBody({
    schema: {
      oneOf: [
        { $ref: getSchemaPath(CreateMemberDto) },
        { $ref: getSchemaPath(InlineMemberDto) },
        { $ref: getSchemaPath(CreateMembersDto) },
      ],
    },
  })
  create(
    @Param() params: MemberIdParamsDto,
    @Body(new CreateMemberPipe()) input: Array<CreateMemberDto | InlineMemberDto>,
    @Req() request: AuthRequest,
  ) {
    return this.members.create(params.id, input, request.admin.adminUserSeq, request.requestId);
  }

  @Patch('members/:id')
  @HttpCode(204)
  @AuditOperation({ action: 'MEMBERSHIP_UPDATED', targetType: 'MEMBERSHIP', target: 'id' })
  @ApiOperation({
    summary: '기업 구성원 대표자 표시·상태 변경',
    description: '사번·고객·기업 변경 불가. INACTIVE는 소속 행을 유지합니다.',
  })
  @ApiNoContentResponse()
  update(
    @Param() params: MemberIdParamsDto,
    @Body() input: UpdateMemberDto,
    @Req() request: AuthRequest,
  ) {
    return this.members.update(params.id, input, request.admin.adminUserSeq, request.requestId);
  }

  @Delete('members/:id')
  @HttpCode(204)
  @AuditOperation({ action: 'MEMBERSHIP_REMOVED', targetType: 'MEMBERSHIP', target: 'id' })
  @ApiOperation({
    summary: '기업 소속 해제',
    description:
      '소속 연결 행만 삭제. 고객·개인 PIN·주문은 보존하며 이후 다른 기업 등록을 허용합니다.',
  })
  @ApiNoContentResponse()
  remove(@Param() params: MemberIdParamsDto, @Req() request: AuthRequest) {
    return this.members.remove(params.id, request.admin.adminUserSeq, request.requestId);
  }
}
