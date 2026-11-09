import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

// Keep the legacy webhook's fail-closed runtime check and credential contract.
@Injectable()
export class PbxWebhookGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.PBX_WEBHOOK_TOKEN;
    if (!expected || Buffer.byteLength(expected) < 32) {
      throw new ServiceUnavailableException(
        'Webhook authentication is not configured',
      );
    }
    const request = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string'
        ? /^Bearer ([^\s]+)$/i.exec(authorization)
        : null;
    if (
      !match ||
      !timingSafeEqual(
        createHash('sha256').update(match[1]).digest(),
        createHash('sha256').update(expected).digest(),
      )
    )
      throw new UnauthorizedException('Invalid webhook credentials');
    return true;
  }
}
