import { Injectable, Logger } from '@nestjs/common';
import { createSign } from 'node:crypto';

import { DatabaseService } from '../database/database.service';

const tokenUrl = 'https://oauth2.googleapis.com/token';
const scope = 'https://www.googleapis.com/auth/firebase.messaging';

type Credentials = { project_id: string; client_email: string; private_key: string };
type IncomingCall = { id: string; callerId: string; calleeId: string; requestedAt: Date };

function loadCredentials(): Credentials | undefined {
  const value = process.env.FCM_SERVICE_ACCOUNT_BASE64?.trim();
  if (!value) return;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    if (
      parsed?.type === 'service_account' &&
      typeof parsed.project_id === 'string' &&
      /^[a-z0-9-]{6,63}$/.test(parsed.project_id) &&
      typeof parsed.client_email === 'string' &&
      typeof parsed.private_key === 'string'
    ) {
      return parsed;
    }
  } catch {
    // Avoid echoing credentials or the parser error.
  }
  throw new Error('Invalid FCM_SERVICE_ACCOUNT_BASE64');
}

@Injectable()
export class CallPushService {
  private readonly logger = new Logger(CallPushService.name);
  private readonly credentials = loadCredentials();
  private access?: Promise<{ token: string; expiresAt: number }>;

  constructor(private readonly database: DatabaseService) {}

  private async exchange(credentials: Credentials) {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: credentials.client_email,
      scope,
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    };
    const encoded = (data: object) => Buffer.from(JSON.stringify(data)).toString('base64url');
    const message = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded(claims)}`;
    const signature = createSign('RSA-SHA256')
      .update(message)
      .sign(credentials.private_key, 'base64url');
    const response = await fetch(tokenUrl, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${message}.${signature}`,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('FCM authentication failed');
    }
    const data: unknown = await response.json();
    if (
      !data ||
      typeof data !== 'object' ||
      !('access_token' in data) ||
      typeof data.access_token !== 'string' ||
      !('expires_in' in data) ||
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    ) {
      throw new Error('FCM authentication returned an invalid token');
    }
    return { token: data.access_token, expiresAt: now + data.expires_in };
  }

  private async authorize(credentials: Credentials): Promise<string> {
    const cached = this.access;
    if (cached && (await cached).expiresAt <= Date.now() / 1000 + 30 && this.access === cached) {
      this.access = undefined;
    }
    this.access ??= this.exchange(credentials).catch((error: unknown) => {
      this.access = undefined;
      throw error;
    });
    return (await this.access).token;
  }

  async incoming(call: IncomingCall): Promise<void> {
    const credentials = this.credentials;
    if (!credentials) return;
    try {
      const { rows } = await this.database.query<{ token: string; callerName: string }>(
        `SELECT push_devices.token, users.display_name AS "callerName"
         FROM push_devices CROSS JOIN users
         WHERE push_devices.user_id = $1 AND users.id = $2
         ORDER BY push_devices.updated_at DESC LIMIT 5`,
        [call.calleeId, call.callerId],
      );
      if (!rows.length) return;
      const accessToken = await this.authorize(credentials);
      const expiresAt = call.requestedAt.getTime() + 60_000;
      const ttl = Math.floor((expiresAt - Date.now()) / 1000);
      if (ttl <= 0) return;
      const endpoint = `https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`;
      const results = await Promise.allSettled(
        rows.map(async ({ token, callerName }) => {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              message: {
                token,
                android: { priority: 'HIGH', ttl: `${ttl}s` },
                data: {
                  type: 'incoming_call',
                  callId: call.id,
                  callerId: call.callerId,
                  callerName,
                  calleeId: call.calleeId,
                  expiresAt: new Date(expiresAt).toISOString(),
                },
              },
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(4_000),
          });
          if (response.status === 404) {
            const result = (await response.json().catch(() => null)) as {
              error?: { details?: ({ errorCode?: string } | null)[] };
            } | null;
            if (
              Array.isArray(result?.error?.details) &&
              result.error.details.some(
                (detail: { errorCode?: string } | null) => detail?.errorCode === 'UNREGISTERED',
              )
            ) {
              await this.database.query(
                'DELETE FROM push_devices WHERE token = $1 AND user_id = $2',
                [token, call.calleeId],
              );
              return;
            }
          } else {
            await response.body?.cancel();
            if (response.ok) return;
          }
          throw new Error('FCM send failed');
        }),
      );
      if (results.some((result) => result.status === 'rejected')) {
        this.logger.warn('Incoming call notification delivery failed for a device');
      }
    } catch {
      this.logger.warn('Incoming call notification could not be sent');
    }
  }
}
