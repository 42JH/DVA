import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

import { DatabaseService } from '../database/database.service';

export type AccountRequest = {
  headers: { authorization?: string };
  accountId: string;
};

const tokenPattern = /^[0-9a-f]{64}$/;
const testAccountNumbers = [1, 2, 3, 4, 5];

export function digestToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

@Injectable()
export class TestAccountGuard implements CanActivate {
  private readonly accounts: { id: string; tokenDigest: Buffer }[];

  constructor(private readonly database: DatabaseService) {
    const tokens = testAccountNumbers.map(
      (number) => process.env[`KICK_TEST_ACCOUNT_${number}_TOKEN`],
    );
    if (tokens.some(Boolean) && (!tokens[0] || !tokens[1])) {
      throw new Error('Configure both Kick test account 1 and 2 tokens');
    }
    const configured = new Set<string>();
    this.accounts = tokens.flatMap((token, index) => {
      if (!token) {
        return [];
      }
      if (!tokenPattern.test(token) || configured.has(token)) {
        throw new Error(
          'Configure distinct Kick test account tokens of 64 lowercase hex characters',
        );
      }
      configured.add(token);
      return [{ id: `kick-test-${testAccountNumbers[index]}`, tokenDigest: digestToken(token) }];
    });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AccountRequest>();
    const token = /^Bearer ([0-9a-f]{64})$/i.exec(request.headers.authorization ?? '')?.[1];
    if (token) {
      const tokenDigest = digestToken(token);
      for (const account of this.accounts) {
        if (timingSafeEqual(account.tokenDigest, tokenDigest)) {
          request.accountId = account.id;
        }
      }
      if (!request.accountId) {
        const { rows } = await this.database.query<{ id: string }>(
          'SELECT id FROM users WHERE access_token_digest = $1',
          [tokenDigest],
        );
        if (rows[0]) {
          request.accountId = rows[0].id;
        }
      }
    }
    if (!request.accountId) {
      throw new UnauthorizedException('Valid account token required');
    }
    return true;
  }
}
