import { Body, Post, HttpCode } from '@nestjs/common';
import { AiBusinessAccess } from '../auth/auth.guard';
import { CompleteOrderIntakeDto } from './dto/complete-order-intake.dto';
import { AuditOperation } from '../audit/audit-operation';
import { Controller, Get, Headers, Param, Req } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  type AuthRequest,
  MvpAiCustomerAccess as AiOrAdminAccess,
  Roles,
} from '../auth/auth.guard';
import {
  ErrorResponseDto,
  RequestMetaDto,
} from '../common/dto/api-response.dto';
import { CallIdParamsDto } from './dto/call-id-params.dto';
import {
  OrderIntakeResponseDto,
  ParcelConversionDto,
} from './dto/order-intake-response.dto';
import { OrderIntakeService } from './order-intake.service';

@ApiTags('Call order intake')
@ApiExtraModels(OrderIntakeResponseDto, ParcelConversionDto, RequestMetaDto)
@ApiResponse({ status: 400, type: ErrorResponseDto })
@ApiResponse({ status: 401, type: ErrorResponseDto })
@ApiResponse({ status: 403, type: ErrorResponseDto })
@ApiResponse({ status: 404, type: ErrorResponseDto })
@ApiResponse({ status: 409, type: ErrorResponseDto })
@ApiResponse({ status: 422, type: ErrorResponseDto })
@ApiResponse({ status: 503, type: ErrorResponseDto })
@ApiOkResponse({
  schema: {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: { $ref: getSchemaPath(OrderIntakeResponseDto) },
      meta: { $ref: getSchemaPath(RequestMetaDto) },
    },
  },
})
@Roles('OPERATOR', 'SYSTEM_ADMIN')
@Controller('calls/:id/order-intake')
export class OrderIntakeController {
  constructor(private readonly intake: OrderIntakeService) {}

  @Post('complete')
  @HttpCode(200)
  @AiBusinessAccess()
  @AuditOperation({
    action: 'ORDER_INTAKE_COMPLETED',
    targetType: 'CALL_SESSION',
    target: 'id',
  })
  @ApiOperation({
    summary: 'AI 주문 데이터 전송 완료 확정',
    security: [{ bearer: [] }],
    description:
      '초안·미완료·수정 요청을 모두 저장한 후 한 번 호출합니다. PBX 종료와 이 신호가 모두 있어야 READY만 실제 주문 하나로 변환합니다. 먼저 도착한 신호는 기다리며, 동일 본문 재전송은 현재 결과를 반환합니다. 확정 후 내용 변경 불가. NO_ORDER는 완성 상세 없음, FINALIZED는 로컬 확정이며 order.status=ACCEPTED만 디버 접수 성공입니다. 실패는 봉인과 초안을 보존하고 워커가 재시도합니다.',
  })
  complete(
    @Param() params: CallIdParamsDto,
    @Body() input: CompleteOrderIntakeDto,
    @Req() request: AuthRequest,
  ) {
    return this.intake.complete(params.id, input, request.requestId);
  }

  @Get()
  @AiOrAdminAccess()
  @ApiOperation({
    summary: '통화 주문 확정 상태·변환 번호 조회',
    security: [{ adminSession: [] }, { bearer: [] }],
    description:
      '입력 중·AI 대기·PBX 대기·확정 중·실패·NO_ORDER·로컬 확정을 구분합니다. 쓰기를 수행하지 않습니다. orderSeq와 draftSeq→orderParcelSeq를 후속 AI 이벤트에 사용합니다. order는 현재 결제·접수 상태이며 원본 주문 삭제/만료 시 null입니다.',
  })
  detail(
    @Param() params: CallIdParamsDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') header?: string,
  ) {
    return this.intake.detail(
      params.id,
      request.admin?.adminUserSeq ?? null,
      header,
    );
  }
}
