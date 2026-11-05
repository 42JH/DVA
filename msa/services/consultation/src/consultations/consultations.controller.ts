import { Controller, Get, Header, Req, Sse } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { type AuthRequest, Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ActiveCallCountService } from './active-call-count.service';
import { ActiveCallCountResponseDto } from './dto/active-call-count.dto';
@ApiTags('Calls')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '조회 조건 또는 통화 번호 형식 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 401,
  description: '관리자 세션이 없거나 만료됨.',
  type: ErrorResponseDto,
})
@ApiResponse({
  status: 403,
  description: '관리자 업무 접근 권한 없음.',
  type: ErrorResponseDto,
})
@Controller('calls')
export class ConsultationsController {
  constructor(private readonly activeCalls: ActiveCallCountService) {}

  @Get('active-count')
  @ApiOperation({
    summary: '진행 중 통화 수 조회',
    description:
      '기능 도입 후 등록된 통화 중 PBX 종료 미확인 건수를 제공합니다. 과거 미확인 통화·주문 상태·AI 분석 완료 여부는 집계 기준으로 사용하지 않습니다.',
  })
  @ApiOkResponse({ type: ActiveCallCountResponseDto })
  @ApiResponse({
    status: 503,
    description: '현재 통화 수를 확인할 수 없음.',
    type: ErrorResponseDto,
  })
  activeCount() {
    return this.activeCalls.read();
  }

  @Sse('active-count/stream')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({
    summary: '진행 중 통화 수 변경 구독',
    description:
      '관리자 쿠키로 구독하며 최초 현재값과 active-call-count 이벤트를 제공합니다. 5초 heartbeat·세션 재검증, session-expired·stream-error 종료 이벤트를 처리해야 합니다.',
  })
  @ApiOkResponse({
    content: {
      'text/event-stream': {
        schema: {
          type: 'string',
          example:
            'event: active-call-count\ndata: {"activeCallCount":37,"observedAt":"2026-11-03T00:00:00.000Z"}\n\n',
        },
      },
    },
  })
  @ApiResponse({
    status: 503,
    description: '초기 구독을 준비할 수 없음.',
    type: ErrorResponseDto,
  })
  activeCountStream(@Req() request: AuthRequest) {
    return this.activeCalls.stream(request.sessionToken);
  }
}
