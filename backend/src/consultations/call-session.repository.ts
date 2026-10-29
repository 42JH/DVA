import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ApiException } from '../common/errors/api.exception';
import { callerPhone } from '../common/caller-phone';
import { CallIdentityDto } from './dto/call-identity.dto';

@Injectable()
export class CallSessionRepository {
  async ensureCall(
    client: PoolClient,
    input: CallIdentityDto & { callerPhoneNumber: string },
  ): Promise<number> {
    const phone = callerPhone(input.callerPhoneNumber);
    await client.query(
      `INSERT INTO call_sessions(provider_call_id,caller_phone_number,incoming_at)
       VALUES($1,$2,$3) ON CONFLICT(provider_call_id) DO NOTHING`,
      [input.providerCallId, phone, input.incomingAt],
    );
    const call = (
      await client.query<{ id: number; matches: boolean }>(
        `SELECT call_session_seq AS id,
         caller_phone_number=$2 AND incoming_at=$3::timestamptz AS matches
       FROM call_sessions WHERE provider_call_id=$1 FOR UPDATE`,
        [input.providerCallId, phone, input.incomingAt],
      )
    ).rows[0];
    if (!call.matches)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '같은 세션의 발신번호·수신 이벤트 시각은 변경할 수 없습니다.',
      );
    return call.id;
  }
}
