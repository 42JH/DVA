import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { isIP } from 'node:net';
import { type Environment } from '../config/environment';
import { RateLimitException } from '../common/errors/api.exception';
import { AuthLimitsService } from './auth-limits.service';

export const LimitAuthRequests = (route: 'login' | 'signup') => SetMetadata('auth:limits', route);

export function authClientIp(request: Request, proxyHops: number): string {
  let address = request.socket.remoteAddress ?? 'unknown';
  if (proxyHops > 0) {
    const chain = (request.get('X-Forwarded-For') ?? '').split(',').map((part) => part.trim());
    const trustedTail = chain.slice(-proxyHops);
    if (trustedTail.length === proxyHops && trustedTail.every((part) => isIP(part)))
      address = trustedTail[0];
  }
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

@Injectable()
export class AuthLimitsGuard implements CanActivate {
  constructor(
    private readonly limits: AuthLimitsService,
    private readonly config: ConfigService<Environment, true>,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const route = this.reflector.get<'login' | 'signup'>('auth:limits', context.getHandler());
    if (!route) return true;
    const request = context.switchToHttp().getRequest<Request>();
    // Nginx's rejected login still uses the app's CORS, JSON envelope and request ID.
    if (request.get('X-Dva-Auth-Limited') === '1') throw new RateLimitException(2);
    if (route === 'signup')
      this.limits.checkSignup(
        authClientIp(request, this.config.get('AUTH_PROXY_HOPS', { infer: true })),
      );
    return true;
  }
}
