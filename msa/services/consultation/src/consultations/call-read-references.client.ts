import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  requestReferences,
  type ReferenceRows,
} from '@dva/events/call-read-references.cjs';
import type { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';

export interface CallReferenceRequest {
  orderSeq: number | null;
  customerSeq: number | null;
  aiPersonaVersionSeq: number | null;
}
export interface CallReferences {
  order: ReferenceRows['order'][];
  customer: ReferenceRows['customer'][];
  persona: ReferenceRows['persona'][];
}

@Injectable()
export class CallReadReferencesClient {
  constructor(private readonly config: ConfigService<Environment, true>) {}

  async read<K extends keyof ReferenceRows>(
    kind: K,
    ids: Array<number | null>,
  ): Promise<ReferenceRows[K][]> {
    const unique = [...new Set(ids.filter((id): id is number => id !== null))];
    if (!unique.length) return [];
    try {
      const url = this.config.get(
        kind === 'order'
          ? 'ORDER_URL'
          : kind === 'customer'
            ? 'CUSTOMER_URL'
            : 'OPERATIONS_URL',
        { infer: true },
      );
      if (!url) throw new Error('Reference owner unavailable');
      return await requestReferences(
        kind,
        url +
          '/internal/call-read-references' +
          (kind === 'faq' ? '/faqs' : ''),
        this.config.get(
          kind === 'order' ? 'CUSTOMER_AUTH_TOKEN' : 'CONSULTATION_AUTH_TOKEN',
          { infer: true },
        ),
        unique,
      );
    } catch {
      throw new ApiException(
        503,
        'DEPENDENCY_UNAVAILABLE',
        '통화 조회 연결 정보를 확인할 수 없습니다.',
      );
    }
  }

  async load(rows: CallReferenceRequest[]): Promise<CallReferences> {
    const order = await this.read(
      'order',
      rows.map((row) => row.orderSeq),
    );
    const orders = new Map(order.map((row) => [row.order_seq, row]));
    const [customer, persona] = await Promise.all([
      this.read(
        'customer',
        rows.map(
          (row) =>
            (row.orderSeq === null
              ? null
              : orders.get(row.orderSeq)?.customer_seq) ?? row.customerSeq,
        ),
      ),
      this.read(
        'persona',
        rows.map((row) => row.aiPersonaVersionSeq),
      ),
    ]);
    return { order, customer, persona };
  }
}
