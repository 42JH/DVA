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
@Roles('OPERATOR', 'SUPERVISOR', 'SYSTEM_ADMIN')
@Controller('calls/:id/order-intake')
export class OrderIntakeController {
  constructor(private readonly intake: OrderIntakeService) {}

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
