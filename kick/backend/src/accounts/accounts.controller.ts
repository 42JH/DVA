import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { DatabaseService } from '../database/database.service';
import { type AccountRequest, digestToken, TestAccountGuard } from './test-account.guard';

type Profile = { id: string; displayName: string };

function pushToken(body: unknown): string {
  if (
    !body ||
    typeof body !== 'object' ||
    Object.keys(body).length !== 1 ||
    !('token' in body) ||
    typeof body.token !== 'string' ||
    !/^[!-~]{1,2048}$/.test(body.token)
  ) {
    throw new BadRequestException('Expected an FCM registration token');
  }
  return body.token;
}

@Controller('api')
export class AccountsController {
  constructor(private readonly database: DatabaseService) {}

  @Post('accounts')
  @Header('Cache-Control', 'no-store')
  async register(@Body() body: unknown): Promise<Profile & { token: string }> {
    const inviteCode = process.env.KICK_SIGNUP_CODE?.trim();
    if (!inviteCode) {
      throw new ServiceUnavailableException('Account registration is not configured');
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Object.keys(body).length !== 2 ||
      !('displayName' in body) ||
      typeof body.displayName !== 'string' ||
      !('inviteCode' in body) ||
      typeof body.inviteCode !== 'string'
    ) {
      throw new BadRequestException('Expected displayName and inviteCode');
    }
    const displayName = body.displayName.trim();
    if (!displayName || displayName.length > 40 || /\p{Cc}/u.test(displayName)) {
      throw new BadRequestException('Display name must contain 1 to 40 characters');
    }
    if (!timingSafeEqual(digestToken(body.inviteCode), digestToken(inviteCode))) {
      throw new ForbiddenException('Invalid registration code');
    }
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    await this.database.query(
      'INSERT INTO users (id, display_name, access_token_digest) VALUES ($1, $2, $3)',
      [id, displayName, digestToken(token)],
    );
    return { id, displayName, token };
  }

  @Get('accounts/me')
  @UseGuards(TestAccountGuard)
  @Header('Cache-Control', 'no-store')
  async me(@Req() request: AccountRequest): Promise<Profile> {
    const { rows } = await this.database.query<Profile>(
      'SELECT id, display_name AS "displayName" FROM users WHERE id = $1',
      [request.accountId],
    );
    return rows[0];
  }

  @Put('devices/push')
  @UseGuards(TestAccountGuard)
  @HttpCode(204)
  async registerPush(@Req() request: AccountRequest, @Body() body: unknown): Promise<void> {
    await this.database.query(
      `INSERT INTO push_devices (token, user_id) VALUES ($1, $2)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, updated_at = now()`,
      [pushToken(body), request.accountId],
    );
  }

  @Delete('devices/push')
  @UseGuards(TestAccountGuard)
  @HttpCode(204)
  async unregisterPush(@Req() request: AccountRequest, @Body() body: unknown): Promise<void> {
    await this.database.query('DELETE FROM push_devices WHERE token = $1 AND user_id = $2', [
      pushToken(body),
      request.accountId,
    ]);
  }
}
