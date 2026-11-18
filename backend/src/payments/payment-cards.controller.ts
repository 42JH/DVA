import { DeleteCompanyCardsDto } from '../common/dto/delete-request.dto';
import { DeleteCustomerCardsDto } from '../common/dto/delete-request.dto';
import { Get } from '@nestjs/common';
import { Body, Controller, Delete, Headers, HttpCode, Param, Put, Req } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { MvpAiCustomerAccess, AuthRequest } from '../auth/auth.guard';
import { AuditOperation } from '../audit/audit-operation';
import { CustomerIdParamsDto } from '../customers/dto/customer-request.dto';
import { PaymentCardsService } from './payment-cards.service';
import { PaymentCardEnvelopeDto, RegisterPaymentCardDto } from './payment-cards.dto';

@ApiTags('Payment cards')
@ApiCookieAuth('adminSession')
@ApiHeader({
  name: 'call_session_seq',
  required: false,
  description: 'AI 요청은 진행 중인 소유 고객 통화 번호가 필요합니다.',
})
@Controller()
export class PaymentCardsController {
  constructor(private readonly cards: PaymentCardsService) {}

  @Get('customers/:id/card')
  @MvpAiCustomerAccess()
  @ApiOperation({
    summary: '개인 등록 카드 마스킹 정보',
    security: [{ adminSession: [] }, { bearer: [] }],
  })
  @ApiOkResponse({ type: PaymentCardEnvelopeDto })
  readCustomer(
    @Param() params: CustomerIdParamsDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') call?: string,
  ) {
    return this.cards.read('CUSTOMER', params.id, request.admin?.adminUserSeq ?? null, call);
  }

  @Get('companies/:id/group-card')
  @MvpAiCustomerAccess()
  @ApiOperation({
    summary: '기업 등록 카드 마스킹 정보',
    security: [{ adminSession: [] }, { bearer: [] }],
  })
  @ApiOkResponse({ type: PaymentCardEnvelopeDto })
  readCompany(
    @Param() params: CustomerIdParamsDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') call?: string,
  ) {
    return this.cards.read('ORGANIZATION', params.id, request.admin?.adminUserSeq ?? null, call);
  }

  @Put('customers/:id/card')
  @MvpAiCustomerAccess()
  @AuditOperation({ action: 'PAYMENT_CARD_REGISTERED', targetType: 'CUSTOMER', target: 'id' })
  @ApiOperation({
    summary: '개인 결제 카드 등록·교체',
    security: [{ adminSession: [] }, { bearer: [] }],
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '카드 등록 요청마다 생성한 UUID. 동일 요청 재시도에 재사용합니다.',
  })
  @ApiOkResponse({ type: PaymentCardEnvelopeDto })
  customer(
    @Param() params: CustomerIdParamsDto,
    @Body() input: RegisterPaymentCardDto,
    @Req() request: AuthRequest,
    @Headers('Idempotency-Key') key?: string,
    @Headers('call_session_seq') call?: string,
  ) {
    return this.cards.register(
      'CUSTOMER',
      params.id,
      input,
      key,
      request.admin?.adminUserSeq ?? null,
      request.requestId,
      call,
    );
  }

  @Put('companies/:id/group-card')
  @MvpAiCustomerAccess()
  @AuditOperation({ action: 'PAYMENT_CARD_REGISTERED', targetType: 'ORGANIZATION', target: 'id' })
  @ApiOperation({
    summary: '기업 공용 카드 등록·교체',
    security: [{ adminSession: [] }, { bearer: [] }],
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: '카드 등록 요청 UUID.' })
  @ApiOkResponse({ type: PaymentCardEnvelopeDto })
  company(
    @Param() params: CustomerIdParamsDto,
    @Body() input: RegisterPaymentCardDto,
    @Req() request: AuthRequest,
    @Headers('Idempotency-Key') key?: string,
    @Headers('call_session_seq') call?: string,
  ) {
    return this.cards.register(
      'ORGANIZATION',
      params.id,
      input,
      key,
      request.admin?.adminUserSeq ?? null,
      request.requestId,
      call,
    );
  }

  @Delete('customers/cards')
  @HttpCode(204)
  @MvpAiCustomerAccess()
  @AuditOperation({
    action: 'PAYMENT_CARD_DELETED',
    targetType: 'CUSTOMER',
    target: 'ids',
    idsField: 'customerSeqs',
  })
  @ApiOperation({
    summary: '개인 카드 등록 해제',
    security: [{ adminSession: [] }, { bearer: [] }],
  })
  @ApiNoContentResponse()
  removeCustomer(
    @Body() input: DeleteCustomerCardsDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') call?: string,
  ) {
    return this.cards.remove(
      'CUSTOMER',
      input.customerSeqs,
      request.admin?.adminUserSeq ?? null,
      request.requestId,
      call,
    );
  }

  @Delete('companies/group-cards')
  @HttpCode(204)
  @MvpAiCustomerAccess()
  @AuditOperation({
    action: 'PAYMENT_CARD_DELETED',
    targetType: 'ORGANIZATION',
    target: 'ids',
    idsField: 'organizationSeqs',
  })
  @ApiOperation({
    summary: '기업 카드 등록 해제',
    security: [{ adminSession: [] }, { bearer: [] }],
  })
  @ApiNoContentResponse()
  removeCompany(
    @Body() input: DeleteCompanyCardsDto,
    @Req() request: AuthRequest,
    @Headers('call_session_seq') call?: string,
  ) {
    return this.cards.remove(
      'ORGANIZATION',
      input.organizationSeqs,
      request.admin?.adminUserSeq ?? null,
      request.requestId,
      call,
    );
  }
}
