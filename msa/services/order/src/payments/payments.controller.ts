import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import {
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiExtraModels,
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiConflictResponse,
  ApiUnprocessableEntityResponse,
  ApiBadGatewayResponse,
  ApiServiceUnavailableResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { Environment } from '../config/environment';
import { PublicAuth } from '../auth/auth.guard';
import { ApiException } from '../common/errors/api.exception';
import { PaymentsService } from './payments.service';
import { PaymentIdDto, PaymentStatusDto } from './payment.dto';
import { paymentPage } from './payment-page';
import { ErrorResponseDto, RequestMetaDto } from '../common/dto/api-response.dto';
const paymentEnvelope = {
  schema: {
    type: 'object',
    required: ['data', 'meta'],
    properties: {
      data: { $ref: getSchemaPath(PaymentStatusDto) },
      meta: { $ref: getSchemaPath(RequestMetaDto) },
    },
  },
};
@ApiTags('Payments')
@ApiExtraModels(PaymentStatusDto, RequestMetaDto)
@ApiBadRequestResponse({ type: ErrorResponseDto })
@ApiForbiddenResponse({ type: ErrorResponseDto })
@ApiNotFoundResponse({ type: ErrorResponseDto })
@ApiConflictResponse({ type: ErrorResponseDto })
@ApiUnprocessableEntityResponse({ type: ErrorResponseDto })
@ApiBadGatewayResponse({ type: ErrorResponseDto })
@ApiServiceUnavailableResponse({ type: ErrorResponseDto })
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  private headers(response: Response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' https://js.tosspayments.com; style-src 'self'; style-src-attr 'unsafe-inline'; connect-src 'self' https://*.tosspayments.com https://*.toss.im; frame-src https:; img-src 'self' data: https:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  }
  @Get('assets/:name')
  @PublicAuth()
  @ApiExcludeEndpoint()
  async asset(@Param('name') name: string, @Res() response: Response) {
    this.payments.ensureEnabled();
    if (!['checkout.js', 'style.css'].includes(name))
      throw new ApiException(404, 'NOT_FOUND', '파일을 찾을 수 없습니다.');
    this.headers(response);
    response
      .type(name.endsWith('.js') ? 'text/javascript' : 'text/css')
      .send(await readFile(join(__dirname, 'assets', name)));
  }
  @Get('p/:id')
  @PublicAuth()
  @ApiExcludeEndpoint()
  page(@Param() p: PaymentIdDto, @Res() response: Response) {
    return this.render(p.id, 'checkout', response);
  }
  @Get('success/:id')
  @PublicAuth()
  @ApiExcludeEndpoint()
  success(@Param() p: PaymentIdDto, @Res() response: Response) {
    return this.render(p.id, 'success', response);
  }
  @Get('fail/:id')
  @PublicAuth()
  @ApiExcludeEndpoint()
  failure(@Param() p: PaymentIdDto, @Res() response: Response) {
    return this.render(p.id, 'failure', response);
  }
  private async render(id: string, mode: string, response: Response) {
    const view = await this.payments.read(id);
    this.headers(response);
    response
      .type('html')
      .send(
        paymentPage(
          view,
          this.config.get('PAYMENT_PUBLIC_URL', { infer: true }),
          this.config.get('TOSS_TEST_CLIENT_KEY', { infer: true }),
          mode,
        ),
      );
  }
  @Get('requests/:id')
  @PublicAuth()
  @Header('Referrer-Policy', 'no-referrer')
  @ApiOperation({
    summary: '주문 결제 상태 조회',
    security: [],
    description:
      '무작위 결제 링크 소유자가 조회합니다. 관리자 세션이나 통화 번호는 필요하지 않습니다.',
  })
  @ApiOkResponse(paymentEnvelope)
  read(@Param() p: PaymentIdDto) {
    return this.payments.read(p.id);
  }
}
