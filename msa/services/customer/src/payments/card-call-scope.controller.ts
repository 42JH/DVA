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
import { validateCardCallScope } from '@dva/events/card-call-scope.cjs';
import { CardCallScopes } from './card-call-scopes.service';

@ApiExcludeController()
@Controller('internal/card-call-scope')
@SetMetadata('auth:internal-consultation', true)
export class CardCallScopeController {
  constructor(private readonly scopes: CardCallScopes) {}

  @Post('callback')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(@Body() event: unknown) {
    try {
      validateCardCallScope(event, 'consultation');
    } catch {
      throw new HttpException({ error: 'INVALID_CARD_CALL_SCOPE' }, 422);
    }
    return this.scopes.execute(event);
  }
}
