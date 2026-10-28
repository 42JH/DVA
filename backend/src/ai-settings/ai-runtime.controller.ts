import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AiSettingsAccess } from './ai-settings-access';
import { PersonaApplicationService } from './persona-application.service';
import { PersonaApplyResultDto, RuntimeConfigQueryDto } from './dto/persona-application.dto';
import { PersonaVersionResponseDto } from './dto/persona-response.dto';

@ApiTags('AI Settings')
@Roles('SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '상태·버전 번호·적용 결과 형식 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 401,
  description: '서비스 토큰 또는 관리자 세션 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 403, description: '관리자 접근 권한 없음.', type: ErrorResponseDto })
@ApiResponse({ status: 503, description: 'AI 서비스 인증 미설정.', type: ErrorResponseDto })
@Controller('ai/config')
export class AiRuntimeController {
  constructor(private readonly applications: PersonaApplicationService) {}

  @Get()
  @AiSettingsAccess(true)
  @ApiOperation({
    summary: '현재 적용·대기 페르소나 조회',
    description:
      '기본값은 서비스 전체의 ACTIVE 한 개입니다. AI는 status=PENDING으로 적용할 최신 설정을 가져옵니다. 대기 설정을 통화에 바로 사용하지 않습니다.',
    security: [{ bearer: [] }, { adminSession: [] }],
  })
  @ApiOkResponse({
    description: '해당 상태의 전체 설정 버전 한 개.',
    type: PersonaVersionResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: '해당 상태의 페르소나 없음. 임의 기본 페르소나를 선택하지 않습니다.',
    type: ErrorResponseDto,
  })
  config(@Query() query: RuntimeConfigQueryDto) {
    return this.applications.runtime(query.status);
  }

  @Post('apply-result')
  @HttpCode(200)
  @AiSettingsAccess()
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'AI 페르소나 적용 결과 수신',
    description:
      'AI 전용. 통화 진입을 잠그고 설정을 설치한 뒤 호출합니다. APPLIED·통화 0건·현재 대기 요청이 모두 일치해야 ACTIVE를 전환합니다. 실패는 대기와 기존 운영 설정을 유지하며 같은 성공 회신은 재사용합니다.',
  })
  @ApiOkResponse({
    description:
      '확인 후 ACTIVE 또는 실패가 기록된 PENDING. HTTP 성공만으로 적용 여부를 판단하지 말고 status를 확인합니다.',
    type: PersonaVersionResponseDto,
  })
  @ApiResponse({
    status: 409,
    description:
      '통화 진행 중, 교체된 대기 요청 또는 버전·applicationId 불일치. AI는 신규 통화를 열기 전에 다시 동기화해야 합니다.',
    type: ErrorResponseDto,
  })
  result(@Body() input: PersonaApplyResultDto, @Req() request: AuthRequest) {
    return this.applications.result(input, request.requestId);
  }
}
