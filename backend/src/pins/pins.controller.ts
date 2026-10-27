import { Controller, Get, Headers, Param, Query, Req } from '@nestjs/common';
import { ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { AuthRequest } from '../auth/auth.guard';
import { MvpAiPinAccess } from '../auth/mvp-ai-access';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ListPinsQueryDto, PinIdParamsDto } from './dto/pin-request.dto';
import { CompanyPinsEnvelopeDto, PersonalPinsEnvelopeDto } from './dto/pin-response.dto';
import { PinsService } from './pins.service';

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

  @Get('companies/:id/pins')
  @MvpAiPinAccess()
  @ApiOperation({
    summary: '기업 공유 주소록 목록·검색',
    security: aiSecurity,
    description: 'AI는 활성 고객·소속·기업 범위만 조회. 관리자는 비활성 기업도 조회 가능.',
  })
  @ApiHeader(callHeader)
  @ApiOkResponse({ type: CompanyPinsEnvelopeDto })
  company(
    @Param() params: PinIdParamsDto,
    @Query() query: ListPinsQueryDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.pins.listCompany(params.id, query, request.admin?.adminUserSeq ?? null, header);
  }
}
