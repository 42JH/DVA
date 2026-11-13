import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { AccessToken, TrackSource } from 'livekit-server-sdk';

@Injectable()
export class LiveKitService {
  async join(callId: string, accountId: string): Promise<{ url: string; token: string }> {
    const url = process.env.LIVEKIT_URL?.trim();
    const key = process.env.LIVEKIT_API_KEY?.trim();
    const secret = process.env.LIVEKIT_API_SECRET?.trim();
    const cloud = /^wss:\/\/[a-z0-9-]+\.livekit\.cloud\/?$/i;
    const local =
      /^ws:\/\/(?:127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}):7880$/;
    if (
      !url ||
      !key ||
      !secret ||
      !(cloud.test(url) || (process.env.LIVEKIT_LOCAL_TEST === 'true' && local.test(url)))
    ) {
      throw new ServiceUnavailableException('LiveKit is not configured');
    }

    const token = new AccessToken(key, secret, { identity: accountId, ttl: '2m' });
    token.addGrant({
      roomJoin: true,
      room: `kick-${callId}`,
      canSubscribe: true,
      canPublish: true,
      canPublishSources: [TrackSource.MICROPHONE],
      canPublishData: true,
    });
    return { url, token: await token.toJwt() };
  }
}
