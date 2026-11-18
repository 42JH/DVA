import { Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { callerPhone } from '../common/caller-phone';
import { DatabaseService } from '../database/database.service';
import { ConsultationsService } from '../consultations/consultations.service';
import { CallEndRepository } from '../consultations/call-end.repository';
import { CallerContextRequestDto } from './dto/caller-context.dto';
import { CustomerContextClient } from './customer-context.client';
import type { Event } from '@dva/events';

@Injectable()
export class CustomersService {
  constructor(
    private readonly repository: CustomerContextClient,
    private readonly database: DatabaseService,
    private readonly calls: ConsultationsService,
    private readonly endings: CallEndRepository,
  ) {}

  async context(
    input: CallerContextRequestDto,
    actorId: number | null,
    requestId: string,
    event: Event,
  ) {
    try {
      const call = input.call;
      if (!call) return await this.repository.context(input.phoneNumber);
      const phoneNumber = callerPhone(input.phoneNumber);
      if (!/^[0-9]{3,20}$/.test(phoneNumber))
        throw new ApiException(
          400,
          'INVALID_REQUEST',
          '통화 발신번호는 3~20자리 숫자여야 합니다.',
        );
      return await this.database.transaction(async (client) => {
        // shortcut: retain command receipts until the cross-service retention worker is ported.
        const receipt = await client.query(
          'INSERT INTO inbox_events(event_id,source,event_type,payload) VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING',
          [event.eventId, event.source, event.eventType, event.payload],
        );
        if (!receipt.rowCount) {
          const existing = await client.query<{ matches: boolean }>(
            'SELECT source=$2 AND event_type=$3 AND payload=$4::jsonb AS matches FROM inbox_events WHERE event_id=$1',
            [event.eventId, event.source, event.eventType, event.payload],
          );
          if (!existing.rows[0]?.matches)
            throw new ApiException(
              409,
              'EVENT_PAYLOAD_CONFLICT',
              '이벤트 본문이 최초 요청과 다릅니다.',
            );
        }
        await this.endings.lockCaller(client, phoneNumber);
        const customerId = await this.repository.callCustomer(phoneNumber);
        const callSessionSeq = await this.calls.ensureCall(
          client,
          { ...call, callerPhoneNumber: phoneNumber },
          actorId,
          requestId,
          customerId,
        );
        const context = await this.repository.context(phoneNumber);
        if (context.customer)
          await this.calls.attachCustomer(
            client,
            callSessionSeq,
            context.customer.customerSeq,
          );
        return { ...context, callSessionSeq };
      });
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '고객 초기 정보를 조회할 수 없습니다.',
      );
    }
  }
}
