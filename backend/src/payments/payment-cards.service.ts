import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { PoolClient } from 'pg';
import { Environment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AuditService } from '../audit/audit.service';
import { AuditActorType } from '../audit/audit.types';
import { ApiException } from '../common/errors/api.exception';
import { ConsultationsService } from '../consultations/consultations.service';
import { CardOwner, PaymentCardsRepository, StoredPaymentCard } from './payment-cards.repository';
import { PaymentCardDto, RegisterPaymentCardDto } from './payment-cards.dto';
import { CardProviderClient } from './card-provider.client';

@Injectable()
export class PaymentCardsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly repository: PaymentCardsRepository,
    private readonly provider: CardProviderClient,
    private readonly audit: AuditService,
    private readonly calls: ConsultationsService,
    private readonly config: ConfigService<Environment, true>,
  ) {}

  private key() {
    const value = this.config.get('PAYMENT_CARD_ENCRYPTION_KEY', { infer: true });
    if (!value)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '카드 저장 암호화가 설정되지 않았습니다.',
      );
    return Buffer.from(value, 'hex');
  }

  environment(): 'test' | 'live' {
    const secret = this.config.get('TOSS_BILLING_SECRET_KEY', { infer: true });
    if (!secret)
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '카드 자동결제 연동이 설정되지 않았습니다.',
      );
    return secret.startsWith('live_') ? 'live' : 'test';
  }

  private summary(card: StoredPaymentCard): PaymentCardDto {
    return {
      paymentCardSeq: card.paymentCardSeq,
      issuerCode: card.issuerCode,
      maskedNumber: card.maskedNumber,
      expirationYear: card.expirationYear,
      expirationMonth: card.expirationMonth,
      active: card.status === 'ACTIVE' && card.deletedAt === null,
    };
  }

  private async access(
    client: PoolClient,
    kind: CardOwner,
    id: number,
    actor: number | null,
    header?: string,
  ) {
    const owner = await this.repository.owner(client, kind, id);
    if (!owner) throw new ApiException(404, 'NOT_FOUND', '카드 소유자를 찾을 수 없습니다.');
    if (owner.status !== 'ACTIVE')
      throw new ApiException(409, 'INVALID_STATE', '활성 고객·기업의 카드만 변경할 수 있습니다.');
    if (actor !== null) return;
    if (!header || !/^[0-9]+$/.test(header) || Number(header) < 1 || Number(header) > 2147483647)
      throw new ApiException(
        400,
        'INVALID_REQUEST',
        'AI 카드 등록에는 call_session_seq가 필요합니다.',
      );
    const caller = await this.calls.ongoingCaller(client, Number(header));
    if (
      kind === 'CUSTOMER'
        ? caller.phone !== owner.phoneNumber ||
          (caller.customerSeq !== null && caller.customerSeq !== id)
        : !(await this.repository.callerBelongs(client, id, caller.phone!, caller.customerSeq))
    )
      throw new ApiException(403, 'FORBIDDEN', '통화 고객의 카드만 변경할 수 있습니다.');
  }

  async register(
    kind: CardOwner,
    id: number,
    input: RegisterPaymentCardDto,
    key: string | undefined,
    actor: number | null,
    requestId: string,
    header?: string,
  ) {
    if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key))
      throw new ApiException(400, 'INVALID_REQUEST', 'UUID Idempotency-Key가 필요합니다.');
    key = key.toLowerCase();
    const now = new Date(Date.now() + 9 * 3600000);
    if (
      input.expirationYear * 12 + input.expirationMonth <
      now.getUTCFullYear() * 12 + now.getUTCMonth() + 1
    )
      throw new ApiException(400, 'INVALID_REQUEST', '만료되지 않은 카드를 등록해 주세요.');
    const environment = this.environment();
    const hash = createHmac('sha256', this.key())
      .update(
        JSON.stringify([
          kind,
          id,
          input.cardNumber,
          input.expirationYear,
          input.expirationMonth,
          input.customerIdentityNumber,
          input.cardPassword ?? null,
          input.customerName ?? null,
        ]),
      )
      .digest('hex');
    const card = await this.database.transaction(async (client) => {
      await client.query("SET LOCAL lock_timeout='2s'");
      await this.access(client, kind, id, actor, header);
      const existing = await this.repository.registration(client, key);
      if (existing) {
        if (existing.requestHash !== hash)
          throw new ApiException(
            409,
            'EVENT_PAYLOAD_CONFLICT',
            '같은 키의 카드 등록 내용이 다릅니다.',
          );
        if (existing.status === 'ACTIVE') return existing;
        if (
          existing.deletedAt ||
          (existing.claimedUntil && existing.claimedUntil.getTime() > Date.now())
        )
          throw new ApiException(
            409,
            'REQUEST_IN_PROGRESS',
            '카드 등록 결과를 확인 중입니다. 실패한 등록은 새 키로 요청해 주세요.',
          );
        await this.repository.renew(client, existing.paymentCardSeq);
        return existing;
      }
      return this.repository.create(
        client,
        kind,
        id,
        key,
        hash,
        environment,
        input.expirationYear,
        input.expirationMonth,
      );
    });
    if (card.status === 'ACTIVE') return this.summary(card);
    const result = await this.provider.register(card.providerCustomerKey, key, input);
    if (
      result.status >= 400 &&
      result.status < 500 &&
      ![401, 403, 408, 409, 429].includes(result.status)
    ) {
      await this.repository.fail(card.paymentCardSeq);
      throw new ApiException(422, 'VALIDATION_FAILED', '카드 등록이 승인되지 않았습니다.');
    }
    const value = result.data;
    if (
      result.status !== 200 ||
      typeof value.billingKey !== 'string' ||
      !value.billingKey ||
      value.billingKey.length > 2000 ||
      value.customerKey !== card.providerCustomerKey
    )
      throw new ApiException(502, 'PAYMENT_RESULT_UNKNOWN', '카드 등록 결과를 확인해 주세요.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(String(card.paymentCardSeq)));
    const encrypted = Buffer.concat([
      iv,
      cipher.update(value.billingKey, 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString('base64');
    return this.database.transaction(async (client) => {
      const owner = await this.repository.owner(client, kind, id);
      if (!owner || owner.status !== 'ACTIVE')
        throw new ApiException(409, 'INVALID_STATE', '카드 소유자 상태가 변경되었습니다.');
      const current = await this.repository.registration(client, key);
      if (!current || current.deletedAt)
        throw new ApiException(409, 'INVALID_STATE', '카드 등록 대상이 변경되었습니다.');
      if (current.status === 'ACTIVE') return this.summary(current);
      await this.softDelete(client, kind, [id], actor, requestId, card.paymentCardSeq);
      const providerCard =
        value.card && typeof value.card === 'object' ? (value.card as Record<string, unknown>) : {};
      const saved = await this.repository.activate(
        client,
        card.paymentCardSeq,
        encrypted,
        typeof providerCard.issuerCode === 'string' ? providerCard.issuerCode.slice(0, 10) : null,
        '************' + input.cardNumber.slice(-4),
      );
      await this.audit.recordSuccess(
        {
          actorId: actor,
          actorType: actor === null ? 'AI' : 'ADMIN',
          targetType: 'PAYMENT_CARD',
          targetId: card.paymentCardSeq,
          action: 'PAYMENT_CARD_REGISTERED',
          requestId,
        },
        client,
      );
      return this.summary(saved);
    });
  }

  async read(kind: CardOwner, id: number, actor: number | null, header?: string) {
    return this.database.transaction(async (client) => {
      await this.access(client, kind, id, actor, header);
      const card = await this.repository.active(kind, id, client);
      return card ? this.summary(card) : null;
    });
  }

  decrypt(
    card: Pick<StoredPaymentCard, 'paymentCardSeq' | 'providerEnvironment' | 'encryptedBillingKey'>,
  ) {
    if (card.providerEnvironment !== this.environment() || !card.encryptedBillingKey)
      throw new ApiException(409, 'INVALID_STATE', '현재 결제 환경에서 사용할 수 없는 카드입니다.');
    const key = this.key();
    try {
      const bytes = Buffer.from(card.encryptedBillingKey, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(String(card.paymentCardSeq)));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
        'utf8',
      );
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '등록 카드의 암호화 설정을 확인해 주세요.',
      );
    }
  }

  async softDelete(
    client: PoolClient,
    kind: CardOwner,
    ids: number[],
    actor: number | null,
    requestId: string,
    except?: number,
    actorType: AuditActorType = actor === null ? 'AI' : 'ADMIN',
  ) {
    for (const row of await this.repository.remove(client, kind, ids, except))
      await this.audit.recordSuccess(
        {
          actorId: actor,
          actorType,
          targetType: 'PAYMENT_CARD',
          targetId: row.id,
          action: 'PAYMENT_CARD_DELETED',
          requestId,
        },
        client,
      );
  }

  async remove(
    kind: CardOwner,
    id: number | number[],
    actor: number | null,
    requestId: string,
    header?: string,
  ) {
    const ids = (Array.isArray(id) ? [...id] : [id]).sort((a, b) => a - b);
    await this.database.transaction(async (client) => {
      for (const id of ids) await this.access(client, kind, id, actor, header);
      await this.softDelete(client, kind, ids, actor, requestId);
    });
  }

  async revokeDeleted(requestId: string) {
    if (
      !this.config.get('TOSS_BILLING_SECRET_KEY', { infer: true }) ||
      !this.config.get('PAYMENT_CARD_ENCRYPTION_KEY', { infer: true })
    )
      return;
    const card = await this.repository.claimRevocation(this.environment());
    if (!card) return;
    const result = await this.provider.revoke(this.decrypt(card));
    if (![200, 404].includes(result.status)) return;
    await this.database.transaction(async (client) => {
      await this.repository.revoked(client, card.paymentCardSeq);
      await this.audit.recordSuccess(
        {
          actorId: null,
          actorType: 'SYSTEM',
          targetType: 'PAYMENT_CARD',
          targetId: card.paymentCardSeq,
          action: 'PAYMENT_CARD_REVOKED',
          requestId,
        },
        client,
      );
    });
  }
}
