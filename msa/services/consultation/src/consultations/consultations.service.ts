import { AuditService } from '../audit/audit.service';
import { CallIdentityDto } from './dto/call-identity.dto';
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
    private readonly audit: AuditService,
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
  async ensureCall(
    client: PoolClient,
    input: CallIdentityDto & { callerPhoneNumber: string },
    actorId: number | null,
    requestId: string,
    customerId: number | null,
  ): Promise<number> {
    await this.endings.lockCaller(client, input.callerPhoneNumber);
    const session = await this.sessions.ensureCall(client, input, customerId);
    await this.endings.matchPending(
      client,
      input.callerPhoneNumber,
      input.incomingAt,
    );
    if (session.created)
      await this.audit.recordSuccess(
        {
          actorId,
          actorType: actorId === null ? 'AI' : 'ADMIN',
          action: 'CALL_STARTED',
          targetType: 'CALL_SESSION',
          targetId: session.id,
          requestId,
        },
        client,
      );
    return session.id;
  }

  attachCustomer(client: PoolClient, callId: number, customerId: number) {
    return this.sessions.attachCustomer(client, callId, customerId);
  }
}
