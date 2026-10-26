import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { PbxWebhookGuard } from './pbx-webhook.guard';
import { parseCallEndedPayload } from './pbx-webhook.payload';
import { PbxWebhookService } from './pbx-webhook.service';

@ApiExcludeController()
@Controller('webhooks/pbx')
export class PbxWebhookController {
  constructor(private readonly webhooks: PbxWebhookService) {}

  @Post('call-ended')
  @HttpCode(200)
  @UseGuards(PbxWebhookGuard)
  receive(@Body() body: unknown) {
    return this.webhooks.receive(parseCallEndedPayload(body));
  }
}
