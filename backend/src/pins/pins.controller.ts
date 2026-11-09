import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCreatedResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuditOperation } from '../audit/audit-operation';
import { AuthRequest } from '../auth/auth.guard';
import { MvpAiPinAccess } from '../auth/mvp-ai-access';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import {
  CreatePinDto,
  ListPinsQueryDto,
  PinIdParamsDto,
  UpdatePinDto,
} from './dto/pin-request.dto';
import {
  CreatedPersonalPinEnvelopeDto,
  PersonalPinsEnvelopeDto,
  PinVersionEnvelopeDto,
} from './dto/pin-response.dto';
import { PinsService } from './pins.service';
import { DeletePinsDto } from './dto/delete-pins.dto';

const callHeader = {
  name: 'call_session_seq',
  required: false,
  description: 'AI 필수·관리자 불필요. 통화 고객 범위를 확인하며 인증 토큰은 아닙니다.',
  schema: { type: 'integer', minimum: 1, maximum: 2147483647 },
};
const aiSecurity: Record<string, string[]>[] = [{ adminSession: [] }, {}];

@ApiTags('Pins')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({
  status: 409,
  type: ErrorResponseDto,
  description: '중복 주소 또는 이용 불가 상태. 버전 차이로 거절하지 않습니다.',
})
@ApiResponse({ status: 422, type: ErrorResponseDto })
@Controller()
export class PinsController {
  constructor(private readonly pins: PinsService) {}

  @Delete('pins')
  @HttpCode(204)
  @ApiCookieAuth('adminSession')
  @AuditOperation({ action: 'PERSONAL_PIN_DELETED', targetType: 'PERSONAL_PIN', target: 'none' })
  @ApiOperation({
    summary: '개인 주소록 단건·다건 soft delete',
    description:
      '모든 ACTIVE 관리자 세션·허용 Origin 전용. personalPinSeqs 배열 1~100개. 여러 고객의 PIN도 함께 선택할 수 있습니다. 고객 기본 주소와 주문 주소 스냅샷은 유지합니다. 미존재·기삭제 또는 감사 저장 실패 시 전체 롤백하며 잠금 경합은 409입니다. AI 통화 헤더로 사용할 수 없습니다.',
  })
  @ApiNoContentResponse({ description: '전체 삭제 완료. 응답 본문 없음.' })
  removeMany(@Body() input: DeletePinsDto, @Req() request: AuthRequest) {
    return this.pins.removeMany(
      input.personalPinSeqs,
      request.admin.adminUserSeq,
      request.requestId,
    );
  }

  @Get('customers/:id/pins')
  @MvpAiPinAccess()
  @ApiOperation({ summary: '개인 주소록 목록·검색', security: aiSecurity })
  @ApiHeader(callHeader)
  @ApiOkResponse({ type: PersonalPinsEnvelopeDto })
  personal(
    @Param() params: PinIdParamsDto,
    @Query() query: ListPinsQueryDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.pins.listPersonal(params.id, query, request.admin?.adminUserSeq ?? null, header);
  }

  @Post('customers/:id/pins')
  @MvpAiPinAccess()
  @AuditOperation({ action: 'PERSONAL_PIN_CREATED', targetType: 'PERSONAL_PIN', target: 'none' })
  @ApiOperation({
    summary: '개인 주소록 등록',
    security: aiSecurity,
    description:
      '해당 통화 고객 또는 관리자. AI는 통화 종료 후에도 추가할 수 있으며 삭제·보관 만료 통화는 거절합니다. 완성 주소 필수. 요청 키 없이 DB 주소 중복 제약을 적용합니다.',
  })
  @ApiHeader(callHeader)
  @ApiCreatedResponse({ type: CreatedPersonalPinEnvelopeDto })
  createPersonal(
    @Param() params: PinIdParamsDto,
    @Body() input: CreatePinDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.pins.createPersonal(
      params.id,
      input,
      request.admin?.adminUserSeq ?? null,
      request.requestId,
      header,
    );
  }

  @Patch('pins/:id')
  @MvpAiPinAccess()
  @AuditOperation({ action: 'PERSONAL_PIN_UPDATED', targetType: 'PERSONAL_PIN', target: 'id' })
  @ApiOperation({
    summary: '개인 주소록 수정',
    security: aiSecurity,
    description:
      '해당 통화 고객은 통화 종료 후에도 수정할 수 있습니다. 삭제·보관 만료 통화는 거절합니다. 버전 비교 없이 지정한 필드만 수정하며 addressData는 완성 주소 전체 교체. 소유 고객 변경 불가.',
  })
  @ApiHeader(callHeader)
  @ApiOkResponse({ type: PinVersionEnvelopeDto })
  updatePersonal(
    @Param() params: PinIdParamsDto,
    @Body() input: UpdatePinDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.pins.updatePersonal(
      params.id,
      input,
      request.admin?.adminUserSeq ?? null,
      request.requestId,
      header,
    );
  }
}
