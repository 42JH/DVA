import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { DashboardService } from './dashboard.service';
import { HomeService } from './home.service';
import { HomeResponseDto } from './dto/home-response.dto';
import { DashboardQueryDto } from './dto/dashboard-query.dto';
import {
  ComplaintCallsResponseDto,
  RegistrationTimeResponseDto,
  ResponseWaitResponseDto,
  StageDropoffsResponseDto,
} from './dto/dashboard-response.dto';

@ApiTags('Dashboard')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 500, type: ErrorResponseDto })
@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboard: DashboardService,
    private readonly homeService: HomeService,
  ) {}

  @Get('home')
  @ApiOperation({
    summary: '홈 처리할 일·미리보기·AI 성능 요약',
    description:
      '한국시간 오늘의 주문·통화 수와 전체 보관 기간의 처리할 일·미리보기·AI 성능을 조회합니다. 기존 목록·통계 기준과 같은 읽기 전용 DB 스냅샷을 사용하며 미리보기는 영역별 최대 11개입니다.',
  })
  @ApiOkResponse({ type: HomeResponseDto })
  home() {
    return this.homeService.home();
  }

  @Get('stage-dropoffs')
  @ApiOperation({
    summary: '단계별 고객 이탈 집계',
    description:
      '종료 통화 중 AI 이탈 판정이 있는 통화가 분모입니다. NONE은 정상, 미수신은 미판정. 단계 진입은 집계하지 않습니다. 삭제/5년 만료 제외, 날짜 필터 없음.',
  })
  @ApiOkResponse({ type: StageDropoffsResponseDto })
  stageDropoffs(@Query() query: DashboardQueryDto) {
    return this.dashboard.stageDropoffs(query);
  }

  @Get('registration-time')
  @ApiOperation({
    summary: '접수 1건당 통화시간과 현재/직전 활성 버전 비교',
    description:
      '접수가 있는 통화 전체 시간 / 접수 확정 배송 상세 수. 결제 대기 포함. PBX 시각 우선·AI 대체. 상단은 선택 고객 전체, 막대는 현재 ACTIVE와 직전 활성 버전만 비교하며 같은 유형의 다른 버전도 구분합니다. 신규·최신·PENDING으로 대체하지 않습니다.',
  })
  @ApiOkResponse({ type: RegistrationTimeResponseDto })
  registrationTime(@Query() query: DashboardQueryDto) {
    return this.dashboard.registrationTime(query);
  }

  @Get('complaint-calls')
  @ApiOperation({
    summary: '고객 불편 표현 통화율·유형별 집계',
    description:
      '판정 완료 통화가 분모입니다. 같은 통화·같은 유형은 한 번, 서로 다른 유형은 각각 집계합니다. 도넛은 화면 6개 유형, 과거 유형은 별도 건수로 제공합니다. RAG/미답변 사유와 독립적입니다.',
  })
  @ApiOkResponse({ type: ComplaintCallsResponseDto })
  complaintCalls(@Query() query: DashboardQueryDto) {
    return this.dashboard.complaintCalls(query);
  }

  @Get('response-wait')
  @ApiOperation({
    summary: '통화 대기 비율·유형별 평균 레이턴시',
    description:
      'AI가 보낸 전체 대기 / 같은 측정 대상의 통화 전체 시간. 유형별 평균은 레이턴시 합계 / 횟수. P95 없음. 수신 후 PBX 보정으로 대기가 통화시간보다 커진 건은 별도 건수로 제공하고 집계에서 제외합니다.',
  })
  @ApiOkResponse({ type: ResponseWaitResponseDto })
  responseWait(@Query() query: DashboardQueryDto) {
    return this.dashboard.responseWait(query);
  }
}
