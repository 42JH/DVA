import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { Request } from 'express';
function authClientIp(request: Request, proxyHops: number): string {
  let address = request.socket.remoteAddress ?? 'unknown';
  if (proxyHops > 0) {
    const chain = (request.get('X-Forwarded-For') ?? '').split(',').map((part) => part.trim());
    const trustedTail = chain.slice(-proxyHops);
    if (trustedTail.length === proxyHops && trustedTail.every((part) => isIP(part)))
      address = trustedTail[0];
  }
  return address.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
}

export const authenticationTypes = new Set([
  'admin_login',
  'admin_session',
  'ai_business',
  'ai_persona',
  'ai_insights',
]);
export type AuthenticationType =
  'admin_login' | 'admin_session' | 'ai_business' | 'ai_persona' | 'ai_insights';
export const authenticationReasons = new Set([
  'authenticated',
  'invalid_credentials',
  'invalid_session',
  'invalid_service_token',
  'account_inactive',
  'account_pending',
  'access_denied',
  'rate_limited',
  'invalid_input',
  'service_unconfigured',
]);
export type SecurityRequest = Request & {
  requestId?: string;
  securityAuthType?: AuthenticationType;
  securityErrorCode?: string;
};

export function authenticationRecord(
  request: SecurityRequest,
  statusCode: number,
  key: string,
  proxyHops: number,
): Record<string, unknown> | undefined {
  const login = request.method === 'POST' && /^\/api\/auth\/login\/*$/i.test(request.path);
  const authType = login ? 'admin_login' : request.securityAuthType;
  if (!authType || !authenticationTypes.has(authType)) return;
  let reason: string;
  if (login && statusCode === 200) reason = 'authenticated';
  else if (statusCode === 401)
    reason =
      authType === 'admin_login'
        ? 'invalid_credentials'
        : authType === 'admin_session'
          ? 'invalid_session'
          : 'invalid_service_token';
  else if (statusCode === 403)
    reason =
      request.securityErrorCode === 'ACCOUNT_INACTIVE'
        ? 'account_inactive'
        : request.securityErrorCode === 'ACCOUNT_PENDING'
          ? 'account_pending'
          : 'access_denied';
  else if (statusCode === 429) reason = 'rate_limited';
  else if (login && [400, 413, 415, 422].includes(statusCode)) reason = 'invalid_input';
  else if (statusCode === 503 && authType.startsWith('ai_')) reason = 'service_unconfigured';
  else return;

  const record: Record<string, unknown> = {
    event: reason === 'authenticated' ? 'authentication_success' : 'authentication_failure',
    authType,
    reason,
    requestId: request.requestId,
    statusCode,
  };
  const pseudonym = (kind: string, value: string) =>
    createHmac('sha256', Buffer.from(key, 'hex'))
      .update(kind + '\0' + value)
      .digest('hex');
  const loginId: unknown = (request.body as { loginId?: unknown } | undefined)?.loginId;
  // A claimed identifier links attempts even for nonexistent accounts, without an extra DB lookup.
  if (
    login &&
    reason !== 'invalid_input' &&
    typeof loginId === 'string' &&
    /^[A-Za-z0-9]{1,20}$/.test(loginId)
  )
    record.accountKey = pseudonym('account', loginId);
  const source = authClientIp(request, proxyHops);
  if (isIP(source)) record.sourceKey = pseudonym('source', source);
  return record;
}
