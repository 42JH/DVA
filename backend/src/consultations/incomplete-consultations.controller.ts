import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiCookieAuth,
  ApiOkResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
} from '@nestjs/swagger';
import { MvpAiOrderIntake } from '../auth/mvp-ai-access';
import { AuditOperation } from '../audit/audit-operation';
import { ErrorResponseDto } from '../common/dto/api-response.dto';
import { CreateIncompleteConsultationDto } from './dto/create-incomplete-consultation.dto';
import { IncompleteConsultationSavedResponseDto } from './dto/incomplete-consultation-response.dto';
import { IncompleteConsultationsService } from './incomplete-consultations.service';
import { Roles } from '../auth/auth.guard';
import {
  IncompleteConsultationIdDto,
  IncompleteConsultationQueryDto,
} from './dto/incomplete-consultation-query.dto';
import {
  IncompleteConsultationDetailResponseDto,
  IncompleteConsultationListDto,
} from './dto/incomplete-consultation-response.dto';

@ApiTags('Incomplete consultations')
@Controller('consultations/incomplete')
export class IncompleteConsultationsController {
  constructor(private readonly consultations: IncompleteConsultationsService) {}

  @Get(':id')
  @Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
  @ApiCookieAuth('adminSession')
  @ApiOperation({
    summary: '관리자 미완료 상담 상세 조회',
    description:
      '종료 당시 스냅샷과 수집·누락·오류 항목을 반환합니다. history는 기존 통화의 기록 존재 정보이며, 녹취 재생 URL과 전체 발화 조회는 88번 API에서 제공합니다. 재통화 복원 API가 아닙니다.',
  })
  @ApiOkResponse({ type: IncompleteConsultationDetailResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  findOne(@Param() params: IncompleteConsultationIdDto) {
    return this.consultations.findOne(params.id);
  }

  @Get()
  @Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
  @ApiCookieAuth('adminSession')
  @ApiOperation({
    summary: '관리자 미완료 상담 목록 조회',
    description: '종료 시각 내림차순. 목록에는 주문 스냅샷과 발화·녹취 원문을 포함하지 않습니다.',
  })
  @ApiOkResponse({ type: IncompleteConsultationListDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  findMany(@Query() query: IncompleteConsultationQueryDto) {
    return this.consultations.findMany(query);
  }

  @Post()
  @MvpAiOrderIntake()
  @AuditOperation({
    action: 'INCOMPLETE_CONSULTATION_RECORDED',
    targetType: 'INCOMPLETE_CONSULTATION',
    target: 'none',
  })
  @ApiOperation({
    summary: 'AI 접수 전 미완료 상담 기록 저장',
    description:
      '종료 시점에 한 번 전달합니다. 같은 통화·동일 이벤트와 본문은 최초 ID를 반환하고 다른 내용은 409로 거절합니다. 주문·고객은 생성하지 않으며 재통화에 복원하지 않습니다. MVP 서비스 인증은 135번에서 도입합니다.',
  })
  @ApiCreatedResponse({ type: IncompleteConsultationSavedResponseDto })
  @ApiBadRequestResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(
    @Body() input: CreateIncompleteConsultationDto,
    @Req() request: Request & { requestId: string },
  ) {
    return this.consultations.create(input, request.requestId);
  }
}
