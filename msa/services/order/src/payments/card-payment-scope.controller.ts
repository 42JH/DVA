import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Post,
  SetMetadata,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { validateCardApprovalScope } from '@dva/events/parcel-draft-write.cjs';
import { PaymentsService } from './payments.service';

@ApiExcludeController()
@SetMetadata('auth:internal-customer', true)
@Controller('internal/card-payment-scope')
export class CardPaymentScopeController {
  constructor(private readonly payments: PaymentsService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  execute(@Body() event: unknown) {
    try {
      validateCardApprovalScope(event, 'customer');
    } catch {
      throw new HttpException({ error: 'INVALID_CARD_APPROVAL_SCOPE' }, 422);
    }
    return this.payments.cardApprovalScope(event);
  }
}
