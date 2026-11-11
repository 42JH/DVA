import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/auth.guard';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { UnansweredQuestionListResponseDto } from './dto/unanswered-question-list-response.dto';
import { UnansweredQuestionQueryDto } from './dto/unanswered-question-query.dto';
import { UnansweredQuestionsService } from './unanswered-questions.service';

@ApiTags('Unanswered Questions')
@ApiCookieAuth('adminSession')
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@ApiResponse({
  status: 400,
  type: ErrorResponseDto,
  description: '식별자·상태·검색어·기간·페이지 조건 오류.',
})
@ApiResponse({ status: 401, type: ErrorResponseDto, description: '활성 관리자 세션 필요.' })
@ApiResponse({ status: 403, type: ErrorResponseDto, description: '접근 권한 없음.' })
@ApiResponse({
  status: 500,
  type: ErrorResponseDto,
  description: '서버 조회 실패. 빈 목록으로 대체하지 않습니다.',
})
@Controller('unanswered-questions')
export class UnansweredQuestionsReadController {
  constructor(private readonly questions: UnansweredQuestionsService) {}

  @Get()
  @ApiOperation({
    summary: '미답변 질문 목록·검색 조회',
    description:
      '기본 OPEN, 질문·현재 고객 이름·발신번호 부분 검색. 기간은 통화 시작 기준이며 from 포함·to 미포함입니다. 오래된 통화부터 반환하며 위치는 정수 초 또는 null. 삭제 원문은 반환하지 않습니다.',
  })
  @ApiOkResponse({ type: UnansweredQuestionListResponseDto })
  findMany(@Query() query: UnansweredQuestionQueryDto) {
    return this.questions.findMany(query);
  }
}
