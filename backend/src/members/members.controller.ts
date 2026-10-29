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
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthRequest } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { ApiException } from '../common/errors/api.exception';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { MembersService } from './members.service';
import {
  CreateMemberDto,
  ListMembersQueryDto,
  MemberIdParamsDto,
  UpdateMemberDto,
} from './dto/member-request.dto';
import { MembersEnvelopeDto } from './dto/member-response.dto';
import { CSV_MAX_BYTES } from './member-csv';
import { CsvUpload } from './members.types';

@ApiTags('Members')
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

  @Get('companies/:id/members')
  @ApiOperation({
    summary: '기업 구성원 목록',
    description: '모든 ACTIVE 관리자. 대표자 표시는 관리자 웹 권한과 무관합니다.',
  })
  @ApiOkResponse({ type: MembersEnvelopeDto })
  list(@Param() params: MemberIdParamsDto, @Query() query: ListMembersQueryDto) {
    return this.members.list(params.id, query);
  }

  @Post('companies/:id/members/import')
  @HttpCode(204)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: CSV_MAX_BYTES + 1, files: 1, fields: 0, parts: 2 },
    }),
  )
  @AuditOperation({ action: 'MEMBERS_IMPORTED', targetType: 'ORGANIZATION', target: 'id' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      additionalProperties: false,
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'UTF-8 CSV. employeeNo,name,phoneNumber. 최대 1MiB·1,000행.',
        },
      },
    },
  })
  @ApiOperation({
    summary: '기업 직원 CSV 등록·갱신',
    description:
      '관리자 CSV에서 기존 사번의 이름·전화번호 수정 허용. 파일 전체를 한 트랜잭션으로 저장합니다.',
  })
  @ApiNoContentResponse()
  @ApiResponse({ status: 413, type: ErrorResponseDto })
  @ApiResponse({ status: 415, type: ErrorResponseDto })
  importCsv(
    @Param() params: MemberIdParamsDto,
    @UploadedFile() file: CsvUpload | undefined,
    @Req() request: AuthRequest,
  ) {
    if (!request.is('multipart/form-data'))
      throw new ApiException(415, 'UNSUPPORTED_MEDIA_TYPE', 'multipart/form-data가 필요합니다.');
    return this.members.importCsv(params.id, file, request.admin.adminUserSeq, request.requestId);
  }

  @Post('companies/:id/members')
  @HttpCode(204)
  @AuditOperation({ action: 'MEMBERSHIP_CREATED', targetType: 'MEMBERSHIP', target: 'none' })
  @ApiOperation({
    summary: '기존 고객을 기업 구성원으로 등록',
    description: 'ACTIVE 고객과 기업만 허용. 같은 고객을 다른 기업으로 자동 이동하지 않습니다.',
  })
  @ApiNoContentResponse()
  create(
    @Param() params: MemberIdParamsDto,
    @Body() input: CreateMemberDto,
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
