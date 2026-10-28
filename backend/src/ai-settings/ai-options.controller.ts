import { Controller, Get } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { AiPersonaClient } from './ai-persona.client';
import { AiOptionsResponseDto } from './dto/persona-response.dto';

@ApiTags('AI Settings')
@ApiCookieAuth('adminSession')
@Roles('SYSTEM_ADMIN')
@Controller('ai')
export class AiOptionsController {
  constructor(private readonly ai: AiPersonaClient) {}
  @Get('options')
  @ApiOperation({
    summary: '지원 음성·응대 옵션 조회',
    description:
      '연결된 AI의 실제 지원값을 반환합니다. 속도 min·max가 null이면 숫자 속도 설정은 허용하지 않습니다.',
  })
  @ApiOkResponse({ description: '지원 음성·속도 범위·말끝 대기 목록.', type: AiOptionsResponseDto })
  @ApiResponse({ status: 401, description: '관리자 세션 없음·만료.', type: ErrorResponseDto })
  @ApiResponse({ status: 403, description: '최상위 관리자 권한 없음.', type: ErrorResponseDto })
  @ApiResponse({
    status: 503,
    description: 'AI 옵션 API 미구현·오류 또는 연동 미설정. 임의 옵션을 반환하지 않습니다.',
    type: ErrorResponseDto,
  })
  options() {
    return this.ai.options();
  }
}
