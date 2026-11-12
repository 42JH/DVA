import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

export type AccountRequest = {
  headers: { authorization?: string };
  accountId: string;
};

const tokenPattern = /^[0-9a-f]{64}$/;

function digest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

@Injectable()
export class TestAccountGuard implements CanActivate {
  private readonly accounts: { id: string; tokenDigest: Buffer }[];

  constructor() {
    const first = process.env.KICK_TEST_ACCOUNT_1_TOKEN;
    const second = process.env.KICK_TEST_ACCOUNT_2_TOKEN;
    if (!first && !second) {
      this.accounts = [];
    } else {
      if (
        !first ||
        !second ||
        !tokenPattern.test(first) ||
        !tokenPattern.test(second) ||
        first === second
      ) {
        throw new Error(
          'Configure two distinct Kick test account tokens of 64 lowercase hex characters',
        );
      }
      this.accounts = [
        { id: 'kick-test-1', tokenDigest: digest(first) },
        { id: 'kick-test-2', tokenDigest: digest(second) },
      ];
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AccountRequest>();
    const token = /^Bearer ([0-9a-f]{64})$/i.exec(request.headers.authorization ?? '')?.[1];
    if (token) {
      const tokenDigest = digest(token);
      for (const account of this.accounts) {
        if (timingSafeEqual(account.tokenDigest, tokenDigest)) {
          request.accountId = account.id;
        }
      }
    }
    if (!request.accountId) {
      throw new UnauthorizedException('Valid test account token required');
    }
    return true;
  }
}
