import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { ConsultationsService } from './consultations.service';
import { CallQueryDto } from './dto/call-query.dto';
import { CallListResponseDto } from './dto/call-response.dto';

@ApiTags('Calls')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  description: '조회 조건 또는 통화 번호 형식 오류.',
  type: ErrorResponseDto,
})
@ApiResponse({ status: 401, description: '관리자 세션이 없거나 만료됨.', type: ErrorResponseDto })
@ApiResponse({ status: 403, description: '관리자 업무 접근 권한 없음.', type: ErrorResponseDto })
@Controller('calls')
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @Get()
  @ApiOperation({
    summary: '통화 목록 조회',
    description:
      '주문·발신번호·시작 기간·종료 사유·상담원 연결 상태로 조회합니다. 시작 시각 최신순이며 시각 미수집 통화는 뒤에 표시합니다. 고객번호 검색은 미지원입니다.',
  })
  @ApiOkResponse({
    description: '통화 목록과 다음 페이지 여부. 연결 기록이 없으면 handoff는 null.',
    type: CallListResponseDto,
  })
  findMany(@Query() query: CallQueryDto) {
    return this.consultations.findMany(query);
  }
}
