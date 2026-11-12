import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import { type AccountRequest, TestAccountGuard } from '../accounts/test-account.guard';
import { CallsService } from './calls.service';

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

@Controller('api')
@UseGuards(TestAccountGuard)
export class CallsController {
  constructor(private readonly callsService: CallsService) {}

  @Get('friends')
  listFriends(@Req() request: AccountRequest) {
    return this.callsService.listFriends(request.accountId);
  }

  @Post('calls')
  requestCall(@Req() request: AccountRequest, @Body() body: unknown) {
    if (
      typeof body !== 'object' ||
      body === null ||
      Object.keys(body).length !== 2 ||
      !('calleeId' in body) ||
      typeof body.calleeId !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(body.calleeId) ||
      !('requestId' in body) ||
      typeof body.requestId !== 'string' ||
      !uuidPattern.test(body.requestId)
    ) {
      throw new BadRequestException('Expected calleeId and a UUID requestId');
    }
    return this.callsService.requestCall(request.accountId, body.calleeId, body.requestId);
  }
}
