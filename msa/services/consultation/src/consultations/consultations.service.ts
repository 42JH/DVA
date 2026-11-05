import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CallSessionRepository } from './call-session.repository';
import { CallEndRepository } from './call-end.repository';
import type { CallEndedPayload } from '../webhooks/pbx/pbx-webhook.payload';
@Injectable()
export class ConsultationsService {
  constructor(
    private readonly sessions: CallSessionRepository,
    private readonly endings: CallEndRepository,
  ) {}
  attachRecording(client: PoolClient, callId: number, objectKey: string) {
    return this.sessions.attachRecording(client, callId, objectKey);
  }
  matchCallEnd(
    client: PoolClient,
    input: CallEndedPayload,
    windowSeconds?: number,
    claimId?: string,
  ) {
    return this.endings.match(client, input, windowSeconds, claimId);
  }
}
