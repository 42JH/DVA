import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Environment } from '../config/environment';
import { ApiException } from '../common/errors/api.exception';
import { isZonedDate, ORDER_ADDRESS_FIELDS } from './order-draft';
import { assertOrderSubmissionReady, OrderSubmissionSnapshot } from './order-submission.validation';

export type DverResult =
  { status: 'ACCEPTED'; parcelNo: string; receivedAt: string } | { status: 'SUBMISSION_FAILED' };

export function dverPayload(order: OrderSubmissionSnapshot, now = Date.now()) {
  assertOrderSubmissionReady(order, now);
  return {
    paymentMethodType: order.paymentMethodType,
    pickupRequestedAt: order.pickupRequestedAt,
    outboundParcels: order.parcels
      .filter((parcel) => parcel.status !== 'CANCELLED')
      .map((parcel) => {
        const address = (side: 'origin' | 'destination') =>
          Object.fromEntries(
            ORDER_ADDRESS_FIELDS.map((field) => [
              field,
              field === 'detailAddress' ? (parcel[side][field] ?? '') : parcel[side][field],
            ]),
          );
        return {
          origin: address('origin'),
          destination: address('destination'),
          item: {
            document: parcel.documentCount,
            smallBox: parcel.smallBoxCount,
            mediumBox: parcel.mediumBoxCount,
            bigBox: parcel.bigBoxCount,
            etc: parcel.otherItemDescription,
          },
          clientComment: parcel.clientComment,
          notifiedPrice: parcel.notifiedPrice,
          itemPrice: parcel.itemPrice,
        };
      }),
  };
}

@Injectable()
export class DverClient {
  private readonly logger = new Logger(DverClient.name);
  constructor(private readonly config: ConfigService<Environment, true>) {}

  ensureConfigured(): string {
    const key = this.config.get('DVER_API_KEY', { infer: true });
    if (!key) throw new ApiException(503, 'DEPENDENCY_UNAVAILABLE', '디버 접수 설정이 필요합니다.');
    return key;
  }

  async submit(payload: ReturnType<typeof dverPayload>, timeoutMs = 10_000): Promise<DverResult> {
    const key = this.ensureConfigured();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    const finish = (result: DverResult, reason?: string): DverResult => {
      this.logger.log({
        event: 'dver_submission',
        outcome: result.status,
        reason,
        durationMs: performance.now() - started,
      });
      return result;
    };
    try {
      const response = await fetch(this.config.get('DVER_API_URL', { infer: true }), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': key,
        },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return finish(
          { status: 'SUBMISSION_FAILED' },
          response.status === 403 ? 'authentication_rejected' : 'http_error',
        );
      }
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = response.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65_536) {
          await reader.cancel();
          return finish({ status: 'SUBMISSION_FAILED' }, 'response_too_large');
        }
        chunks.push(value);
      }
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return finish({ status: 'SUBMISSION_FAILED' }, 'invalid_response');
      }
      if (
        typeof result === 'object' &&
        result !== null &&
        'ok' in result &&
        result.ok === true &&
        'parcelNo' in result &&
        typeof result.parcelNo === 'string' &&
        /^[A-Za-z0-9]{8}$/.test(result.parcelNo) &&
        'receivedAt' in result &&
        typeof result.receivedAt === 'string' &&
        isZonedDate(result.receivedAt)
      )
        return finish({
          status: 'ACCEPTED',
          parcelNo: result.parcelNo,
          receivedAt: result.receivedAt,
        });
      return finish({ status: 'SUBMISSION_FAILED' }, 'invalid_response');
    } catch {
      // 단일 HTTP 호출은 재시도하지 않는다. 다음 전송은 워커·관리자가 결정한다.
      return finish(
        { status: 'SUBMISSION_FAILED' },
        controller.signal.aborted ? 'timeout' : 'transport_error',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
