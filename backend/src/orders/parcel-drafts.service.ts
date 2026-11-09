import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { ApiException } from '../common/errors/api.exception';
import { ListResponse } from '../common/pagination';
import { DatabaseService } from '../database/database.service';
import {
  CreateParcelDraftDto,
  ParcelDraftQueryDto,
  PatchParcelDraftDto,
} from './dto/parcel-draft.dto';
import { ParcelInputDto } from './dto/create-order.dto';
import { orderDraft, ORDER_ADDRESS_FIELDS, isZonedDate } from './order-draft';
import { assertOrderSubmissionReady } from './order-submission.validation';
import { writeOrder } from './order-write';
import { OrdersRepository } from './orders.repository';
import { ParcelDraftsRepository } from './parcel-drafts.repository';
import { OrderIntakeCall, ParcelDraftRow } from './parcel-drafts.types';

function response(row: ParcelDraftRow) {
  const result: Partial<ParcelDraftRow> = { ...row };
  delete result.creationPayload;
  return result as Omit<ParcelDraftRow, 'creationPayload'>;
}

function provided(value: object = {}) {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined));
}

function mergeParcel(base: ParcelDraftRow['parcel'], patch: ParcelInputDto = {}) {
  return orderDraft({
    parcels: [
      {
        ...base,
        ...provided(patch),
        origin: { ...base.origin, ...provided(patch.origin) },
        destination: { ...base.destination, ...provided(patch.destination) },
      },
    ],
  }).parcels[0];
}

@Injectable()
export class ParcelDraftsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: ParcelDraftsRepository,
    private readonly orders: OrdersRepository,
    private readonly audit: AuditService,
  ) {}

  headerId(header?: string): number {
    if (!header || !/^[0-9]+$/.test(header) || Number(header) < 1 || Number(header) > 2147483647)
      throw new ApiException(400, 'INVALID_REQUEST', '유효한 call_session_seq가 필요합니다.');
    return Number(header);
  }

  async accessCall(
    client: PoolClient,
    id: number,
    write: boolean,
    allowSealed = false,
  ): Promise<OrderIntakeCall> {
    const call = await this.repository.call(client, id, write);
    if (!call) throw new ApiException(404, 'NOT_FOUND', '통화를 찾을 수 없습니다.');
    if (!call.enabled)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '이전 계약의 통화입니다. 새 통화에서 초안을 접수해 주세요.',
      );
    if (call.customerSeq === null && call.callerPhoneNumber) {
      const customer = await this.orders.customerByPhone(client, call.callerPhoneNumber);
      call.customerSeq = customer?.customerSeq ?? null;
      if (write && call.customerSeq !== null)
        await client.query(
          'UPDATE call_sessions SET customer_seq=$2 WHERE call_session_seq=$1 AND customer_seq IS NULL',
          [id, call.customerSeq],
        );
    }
    if (
      !call.callerPhoneNumber ||
      (call.customerSeq !== null && !(await this.repository.customer(client, call.customerSeq)))
    )
      throw new ApiException(403, 'FORBIDDEN', '통화 발신번호와 활성 고객 연결을 확인해 주세요.');
    if (write && call.customerSeq !== null)
      await client.query(
        'UPDATE order_parcel_drafts SET customer_seq=$2 WHERE call_session_seq=$1 AND customer_seq IS NULL',
        [id, call.customerSeq],
      );
    if (write && !allowSealed && (call.completionReceivedAt !== null || call.orderSeq !== null))
      throw new ApiException(409, 'INVALID_STATE', '주문 입력이 확정된 통화입니다.');
    return call;
  }

  private async context(
    client: PoolClient,
    adminId: number | null,
    header: string | undefined,
    write: boolean,
    allowSealed = false,
  ) {
    return adminId === null
      ? this.accessCall(client, this.headerId(header), write, allowSealed)
      : null;
  }

  private scope(row: ParcelDraftRow, call: OrderIntakeCall | null, write: boolean) {
    if (call) {
      const ownCall =
        row.callSessionSeq === call.callSessionSeq &&
        (row.customerSeq === null || row.customerSeq === call.customerSeq);
      const history =
        !write &&
        call.endedAt === null &&
        (row.customerSeq !== null
          ? row.customerSeq === call.customerSeq
          : row.status === 'INCOMPLETE' &&
            row.callerPhoneNumber !== null &&
            row.callerPhoneNumber === call.callerPhoneNumber);
      if (!ownCall && !history)
        throw new ApiException(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
    }
    if (!call && write && row.callSessionSeq !== null)
      throw new ApiException(
        409,
        'INVALID_STATE',
        '통화 초안은 미완료 확정 후 새 초안으로 재개해 주세요.',
      );
  }

  private async validate(
    client: PoolClient,
    customerId: number | null,
    parcel: ParcelDraftRow['parcel'],
    ready: boolean,
    previous?: ParcelDraftRow['parcel'],
  ) {
    const historicalCompany =
      parcel.originPin?.scope === 'COMPANY' &&
      previous?.originPin?.scope === 'COMPANY' &&
      parcel.originPin.pinSeq === previous.originPin.pinSeq &&
      ORDER_ADDRESS_FIELDS.every((field) => parcel.origin[field] === previous.origin[field]);
    if (
      parcel.originPin &&
      !historicalCompany &&
      (customerId === null ||
        parcel.originPin.scope !== 'PERSONAL' ||
        !(await this.orders.canUsePin(client, customerId, parcel.originPin)))
    )
      throw new ApiException(403, 'FORBIDDEN', '고객이 사용할 수 없는 출발지 PIN입니다.');
    if (ready && customerId === null)
      throw new ApiException(403, 'FORBIDDEN', 'READY 확정에는 등록된 활성 고객이 필요합니다.');
    if (ready)
      assertOrderSubmissionReady(
        { paymentMethodType: 'billing', pickupRequestedAt: null, parcels: [parcel] },
        Date.now(),
        false,
      );
  }

  private record(
    client: PoolClient,
    adminId: number | null,
    id: number,
    action: string,
    requestId: string,
  ) {
    return this.audit.recordSuccess(
      {
        actorId: adminId,
        actorType: adminId === null ? 'AI' : 'ADMIN',
        targetId: id,
        targetType: 'ORDER_PARCEL_DRAFT',
        action,
        requestId,
      },
      client,
    );
  }

  async create(
    adminId: number | null,
    input: CreateParcelDraftDto,
    requestId: string,
    header?: string,
  ) {
    if (input.parcel === undefined && input.sourceDraftSeq === undefined)
      throw new ApiException(400, 'INVALID_REQUEST', '새 배송 초안에는 parcel이 필요합니다.');
    return writeOrder(this.database, async (client) => {
      const call = await this.context(client, adminId, header, true, true);
      const sourceHint =
        input.sourceDraftSeq === undefined
          ? undefined
          : await this.repository.draft(client, input.sourceDraftSeq);
      const customerId = call
        ? call.customerSeq
        : (input.customerSeq ?? sourceHint?.customerSeq ?? null);
      if (
        (call && input.customerSeq !== undefined && input.customerSeq !== call.customerSeq) ||
        (!call && customerId === null)
      )
        throw new ApiException(403, 'FORBIDDEN', '통화 고객과 초안 고객이 일치해야 합니다.');
      if (customerId !== null && !(await this.repository.customer(client, customerId)))
        throw new ApiException(404, 'NOT_FOUND', '활성 고객을 찾을 수 없습니다.');
      const payload: Record<string, unknown> = JSON.parse(
        JSON.stringify({
          status: input.status,
          parcel: input.parcel ?? null,
          sourceDraftSeq: input.sourceDraftSeq ?? null,
          customerSeq: input.customerSeq ?? null,
        }),
      );
      // Serialize administrator standalone creates too; the row uniqueness remains the final guard.
      if (!call && !(await this.orders.lockCreation(client, input.clientParcelId)))
        throw new ApiException(409, 'REQUEST_IN_PROGRESS', '같은 초안 생성 요청을 처리 중입니다.');
      const previous = await this.repository.byClientId(
        client,
        call?.callSessionSeq ?? null,
        input.clientParcelId,
      );
      if (previous) {
        if (previous.customerSeq !== customerId || previous.createdByAdminUserSeq !== adminId)
          throw new ApiException(403, 'FORBIDDEN', '다른 주체가 사용한 초안 생성 키입니다.');
        if (previous.unavailable || !isDeepStrictEqual(previous.creationPayload, payload))
          throw new ApiException(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            '삭제·만료된 키이거나 같은 키의 생성 내용이 다릅니다.',
          );
        const row: ParcelDraftRow & { unavailable?: boolean } = { ...previous };
        delete row.unavailable;
        return { ...response(row), intakeVersion: call?.intakeVersion ?? null };
      }
      if (call && (call.completionReceivedAt !== null || call.orderSeq !== null))
        throw new ApiException(409, 'INVALID_STATE', '주문 입력이 확정된 통화입니다.');
      const source =
        input.sourceDraftSeq === undefined
          ? undefined
          : await this.repository.draft(client, input.sourceDraftSeq, true);
      if (
        input.sourceDraftSeq !== undefined &&
        (!source || (source.customerSeq !== null && source.customerSeq !== customerId))
      )
        throw new ApiException(404, 'NOT_FOUND', '재개할 초안을 찾을 수 없습니다.');
      if (
        source &&
        (source.status !== 'INCOMPLETE' || (call && source.callSessionSeq === call.callSessionSeq))
      )
        throw new ApiException(
          409,
          'INVALID_STATE',
          '다른 통화에서 미완료로 확정된 초안만 재개할 수 있습니다.',
        );
      if (source && call) this.scope(source, call, false);
      const parcel = mergeParcel(
        source?.parcel ?? orderDraft({ parcels: [{}] }).parcels[0],
        input.parcel,
      );
      await this.validate(client, customerId, parcel, input.status === 'READY', source?.parcel);
      // Transfer the reservation while holding the source lock; rollback restores both rows.
      if (source) {
        if (source.customerSeq === null && customerId !== null)
          await client.query('UPDATE order_parcel_drafts SET customer_seq=$2 WHERE draft_seq=$1', [
            source.draftSeq,
            customerId,
          ]);
        await this.repository.update(client, source.draftSeq, source.parcel, 'RESUMED');
        await this.record(client, adminId, source.draftSeq, 'PARCEL_DRAFT_RESUMED', requestId);
      }
      const row = await this.repository.insert(client, {
        callId: call?.callSessionSeq ?? null,
        customerId,
        callerPhoneNumber: call?.callerPhoneNumber ?? source?.callerPhoneNumber ?? null,
        adminId,
        key: input.clientParcelId,
        payload,
        parcel,
        status: input.status,
        source,
      });
      const intakeVersion = call
        ? await this.repository.bumpCall(client, call.callSessionSeq)
        : null;
      await this.record(client, adminId, row.draftSeq, 'PARCEL_DRAFT_CREATED', requestId);
      return { ...response(row), intakeVersion };
    });
  }

  async patch(
    adminId: number | null,
    id: number,
    input: PatchParcelDraftDto,
    requestId: string,
    header?: string,
  ) {
    if (
      (input.action === 'START_EDIT' &&
        (!input.clearFields || input.parcel !== undefined || input.status !== undefined)) ||
      (input.action === 'SAVE' && (!input.status || input.clearFields !== undefined)) ||
      (input.action === 'CANCEL' &&
        (input.clearFields !== undefined ||
          input.parcel !== undefined ||
          input.status !== undefined))
    )
      throw new ApiException(400, 'INVALID_REQUEST', 'action에 맞는 수정 필드를 전달해 주세요.');
    return writeOrder(this.database, async (client) => {
      const call = await this.context(client, adminId, header, true);
      const hint = await this.repository.draft(client, id);
      if (!hint) throw new ApiException(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
      this.scope(hint, call, true);
      if (hint.customerSeq !== null && !(await this.repository.customer(client, hint.customerSeq)))
        throw new ApiException(404, 'NOT_FOUND', '활성 고객을 찾을 수 없습니다.');
      const row = (await this.repository.draft(client, id, true))!;
      if (!row) throw new ApiException(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
      if (row.version !== input.expectedVersion)
        throw new ApiException(
          409,
          'VERSION_CONFLICT',
          '초안이 변경되었습니다. 최신 내용을 조회해 주세요.',
        );
      if (!['READY', 'EDITING'].includes(row.status))
        throw new ApiException(409, 'INVALID_STATE', '수정 가능한 초안이 아닙니다.');
      let parcel = row.parcel;
      let status = row.status;
      if (input.action === 'START_EDIT') {
        parcel = { ...parcel };
        const empty = orderDraft({ parcels: [{}] }).parcels[0];
        for (const field of input.clearFields!) {
          if (field === 'items') {
            parcel.documentCount =
              parcel.smallBoxCount =
              parcel.mediumBoxCount =
              parcel.bigBoxCount =
                0;
            parcel.otherItemDescription = '';
          } else Object.assign(parcel, { [field]: empty[field] });
          if (['origin', 'destination', 'items', 'itemPrice'].includes(field))
            parcel.notifiedPrice = null;
          if (field === 'origin') parcel.originPin = null;
        }
        status = 'EDITING';
      } else if (input.action === 'SAVE') {
        if (row.status !== 'EDITING')
          throw new ApiException(
            409,
            'INVALID_STATE',
            'READY 수정 전에 START_EDIT를 전송해 주세요.',
          );
        parcel = mergeParcel(row.parcel, input.parcel);
        status = input.status!;
        await this.validate(client, row.customerSeq, parcel, status === 'READY', row.parcel);
      } else status = 'CANCELLED';
      await this.repository.update(client, id, parcel, status);
      const intakeVersion = call
        ? await this.repository.bumpCall(client, call.callSessionSeq)
        : null;
      await this.record(
        client,
        adminId,
        id,
        input.action === 'CANCEL' ? 'PARCEL_DRAFT_CANCELLED' : 'PARCEL_DRAFT_UPDATED',
        requestId,
      );
      return { ...response((await this.repository.draft(client, id))!), intakeVersion };
    });
  }

  async detail(adminId: number | null, id: number, header?: string) {
    return this.database.transaction(async (client) => {
      const call = await this.context(client, adminId, header, false);
      const row = await this.repository.draft(client, id);
      if (!row) throw new ApiException(404, 'NOT_FOUND', '초안을 찾을 수 없습니다.');
      this.scope(row, call, false);
      return { ...response(row), intakeVersion: call?.intakeVersion ?? null };
    });
  }

  async list(adminId: number | null, query: ParcelDraftQueryDto, header?: string) {
    if (
      (query.from !== undefined && !isZonedDate(query.from)) ||
      (query.to !== undefined && !isZonedDate(query.to)) ||
      (query.from && query.to && Date.parse(query.from) >= Date.parse(query.to))
    )
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        '조회 기간을 확인해 주세요. from은 to보다 빨라야 합니다.',
      );
    return this.database.transaction(async (client) => {
      const call = await this.context(client, adminId, header, false);
      if (call && query.customerSeq !== undefined && query.customerSeq !== call.customerSeq)
        throw new ApiException(403, 'FORBIDDEN', '다른 고객의 초안은 조회할 수 없습니다.');
      return new ListResponse(
        await this.repository.list(
          client,
          query,
          call?.customerSeq ?? query.customerSeq ?? null,
          call?.endedAt ? call.callSessionSeq : null,
          call,
        ),
        query.limit,
      );
    });
  }
}
