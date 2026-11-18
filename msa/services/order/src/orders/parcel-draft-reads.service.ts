import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { isISO8601 } from 'class-validator';
import { requestDraftRead, OrderReadError } from '@dva/events/order-read.cjs';
import {
  requestDraftReadCall,
  requestDraftCallReferences,
  type DraftReadCall,
  type DraftReadCommand,
  type DraftReadEvent,
} from '@dva/events/parcel-drafts.cjs';
import { requestOrderOrganization } from '@dva/events/call-read-references.cjs';
import { readCallbackUrl } from '@dva/events/read-scope.cjs';
import { ApiException, type ErrorCode } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { createValidationPipe } from '../common/http/validation.pipe';
import { DatabaseService } from '../database/database.service';
import type { Environment } from '../config/environment';
import { ParcelDraftQueryDto } from './dto/parcel-draft.dto';
import { ParcelDraftReadsRepository } from './parcel-draft-reads.repository';
import type { ParcelDraftRow } from './parcel-drafts.types';

@Injectable()
export class ParcelDraftReadsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ParcelDraftReadsRepository,
    private readonly config: ConfigService<Environment, true>,
  ) {}
  private headerId(header?: string): number {
    if (!header || !/^\d+$/.test(header) || Number(header) < 1 || Number(header) > 2147483647)
      throw new ApiException(400, 'INVALID_REQUEST', '유효한 call_session_seq가 필요합니다.');
    return Number(header);
  }
  private assertDateRange(query: ParcelDraftQueryDto) {
    const zoned = (value: string) =>
      isISO8601(value, { strict: true, strictSeparator: true }) &&
      /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
      Number.isFinite(Date.parse(value));
    if (
      (query.from !== undefined && !zoned(query.from)) ||
      (query.to !== undefined && !zoned(query.to)) ||
      (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to))
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '조회 기간을 확인해 주세요. from은 to보다 빨라야 합니다.',
      );
  }
  list(adminId: number | null, query: ParcelDraftQueryDto, header?: string) {
    this.assertDateRange(query);
    return this.read({
      operation: 'ParcelDraftsListed',
      id: null,
      callSessionSeq: adminId === null ? this.headerId(header) : null,
      query: { ...query },
    });
  }
  detail(adminId: number | null, id: number, header?: string) {
    return this.read({
      operation: 'ParcelDraftDetailRead',
      id,
      callSessionSeq: adminId === null ? this.headerId(header) : null,
      query: {},
    });
  }
  private async read(command: DraftReadCommand) {
    try {
      const result = await requestDraftRead(
        this.config.get('CONSULTATION_URL', { infer: true }) + '/internal/parcel-draft-read',
        this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true }),
        {
          eventId: randomUUID(),
          source: 'order',
          eventType: 'ParcelDraftReadRequested',
          payload: {
            command,
            orderAddress: this.config.get('MSA_INSTANCE_IP', { infer: true }) ?? null,
          },
        },
      );
      return command.operation === 'ParcelDraftsListed'
        ? Object.assign(Object.create(ListResponse.prototype) as ListResponse<unknown>, result)
        : result;
    } catch (error) {
      if (error instanceof OrderReadError)
        throw new ApiException(
          error.status,
          error.error.code as ErrorCode,
          error.error.message,
          error.error.details,
        );
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '서비스를 일시적으로 사용할 수 없습니다.',
      );
    }
  }
  private scope(row: ParcelDraftRow, call: DraftReadCall | null) {
    if (!call) return;
    const own =
      row.callSessionSeq === call.callSessionSeq &&
      (row.customerSeq === null || row.customerSeq === call.customerSeq);
    const history =
      call.endedAt === null &&
      (row.customerSeq !== null
        ? row.customerSeq === call.customerSeq
        : row.status === 'INCOMPLETE' &&
          row.callerPhoneNumber !== null &&
          row.callerPhoneNumber === call.callerPhoneNumber);
    if (!own && !history) throw new ApiException(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
  }
  async execute(event: DraftReadEvent) {
    const command = event.payload.command;
    const query =
      command.operation === 'ParcelDraftsListed'
        ? ((await createValidationPipe().transform(command.query, {
            metatype: ParcelDraftQueryDto,
            type: 'query',
          })) as ParcelDraftQueryDto)
        : null;
    if (query) this.assertDateRange(query);
    const token = this.config.get('CUSTOMER_AUTH_TOKEN', { infer: true });
    const consultation = (path: string) =>
      readCallbackUrl(
        this.config.get('CONSULTATION_URL', { infer: true }),
        path,
        event.payload.consultationAddress ?? null,
      );
    const storedCall =
      command.callSessionSeq === null
        ? null
        : await requestDraftReadCall(
            consultation('/internal/parcel-draft-read/call'),
            token,
            command.callSessionSeq,
            event.eventId,
          );
    const call =
      storedCall === null
        ? null
        : { ...storedCall, customerSeq: event.payload.customerSeq ?? null };
    if (call && query && query.customerSeq !== undefined && query.customerSeq !== call.customerSeq)
      throw new ApiException(403, 'FORBIDDEN', '다른 고객의 초안은 조회할 수 없습니다.');
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SELECT 1');
      const references = (input: { callIds: number[]; customerIds: number[]; phones: string[] }) =>
        requestDraftCallReferences(
          consultation('/internal/order-draft-call-references'),
          token,
          input,
          event.eventId,
        );
      if (query) {
        const org =
          query.organizationSeq === undefined
            ? null
            : await requestOrderOrganization(
                readCallbackUrl(
                  this.config.get('CUSTOMER_URL', { infer: true }),
                  '/internal/call-read-references/order-organization',
                  event.payload.customerAddress ?? null,
                ),
                token,
                query.organizationSeq,
                event.eventId,
              );
        return new ListResponse(
          await this.repository.list(
            client,
            query,
            call?.customerSeq ?? query.customerSeq ?? null,
            call?.endedAt ? call.callSessionSeq : null,
            call,
            org?.customer_seqs ?? null,
            references,
          ),
          query.limit,
        );
      }
      const row = await this.repository.draft(client, command.id!, references);
      if (!row) throw new ApiException(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
      this.scope(row, call);
      return { ...row, intakeVersion: call?.intakeVersion ?? null };
    });
  }
}
