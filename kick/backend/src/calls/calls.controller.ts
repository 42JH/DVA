import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { distinctUntilChanged, exhaustMap, map, merge, timer, type Observable } from 'rxjs';

import { type AccountRequest, TestAccountGuard } from '../accounts/test-account.guard';
import { CallsService } from './calls.service';
import { LiveKitService } from './livekit.service';

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

@Controller('api')
@UseGuards(TestAccountGuard)
export class CallsController {
  constructor(
    private readonly callsService: CallsService,
    private readonly liveKit: LiveKitService,
  ) {}

  @Get('friends')
  listFriends(@Req() request: AccountRequest) {
    return this.callsService.listFriends(request.accountId);
  }

  @Put('friends/:id')
  addFriend(@Req() request: AccountRequest, @Param('id') id: string) {
    if (!/^[a-z0-9-]{1,64}$/.test(id)) {
      throw new BadRequestException('Expected a Kick account ID');
    }
    return this.callsService.addFriend(request.accountId, id);
  }

  @Get('calls/active')
  @Header('Cache-Control', 'no-store')
  activeCall(@Req() request: AccountRequest) {
    return this.callsService.activeCall(request.accountId);
  }

  @Sse('calls/events')
  callEvents(@Req() request: AccountRequest): Observable<MessageEvent> {
    // shortcut: refresh the PostgreSQL snapshot once per second for the test accounts, switch to event delivery when usage grows.
    const calls = timer(0, 1_000).pipe(
      exhaustMap(() => this.callsService.activeCall(request.accountId)),
      distinctUntilChanged(
        (previous, current) =>
          previous.call?.id === current.call?.id && previous.call?.status === current.call?.status,
      ),
      map((data) => ({ type: 'call', data })),
    );
    return merge(calls, timer(15_000, 15_000).pipe(map(() => ({ comment: 'keepalive' }))));
  }

  @Get('calls/:id')
  @Header('Cache-Control', 'no-store')
  getCall(@Req() request: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.callsService.getCall(request.accountId, id);
  }

  @Patch('calls/:id')
  transition(
    @Req() request: AccountRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    if (
      typeof body !== 'object' ||
      body === null ||
      Object.keys(body).length !== 1 ||
      !('action' in body)
    ) {
      throw new BadRequestException('Expected call action');
    }
    const { action } = body;
    if (action !== 'accept' && action !== 'reject' && action !== 'cancel' && action !== 'end') {
      throw new BadRequestException('Unknown call action');
    }
    return this.callsService.transition(request.accountId, id, action);
  }

  @Post('calls/:id/join')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async join(@Req() request: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    const call = await this.callsService.getCall(request.accountId, id);
    if (call.status !== 'ACCEPTED') {
      throw new ConflictException('The call must be accepted before joining');
    }
    return this.liveKit.join(id, request.accountId);
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
