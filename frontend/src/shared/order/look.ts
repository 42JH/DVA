// 주문 — 상태 · 품목 · 시각을 화면 글로 (React 모름)
import type { OrderStatusDto } from './orderDto'
import type { Tone } from '@/shared/ui'
import { fmtNum } from '@/shared/lib/format'

/** 실제 상태 8개를 그대로 보여 줌 (기존 화면은 묶음 5개) — 결제 완료 뒤 디버 접수 진행까지 운영팀이 봐야 해서 */
export const STATUS_LOOK: Record<OrderStatusDto, { label: string; tone: Tone }> = {
  COLLECTING: { label: '미완료', tone: 'idle' }, // 미완료는 회색으로 죽이기
  notPaid: { label: '결제 대기', tone: 'wait' },
  PAID: { label: '결제 완료', tone: 'done' },
  SUBMITTING: { label: '디버 접수 중', tone: 'route' },
  ACCEPTED: { label: '접수 완료', tone: 'done' },
  SUBMITTING_FAILED: { label: '접수 재시도', tone: 'stop' },
  SUBMISSION_FAILED: { label: '접수 실패', tone: 'cancel' },
  CANCELLED: { label: '주문 취소', tone: 'stop' },
}

type Items = { document: number; small: number; medium: number; big: number; other?: string | null }

/** '서류 1, 소 2, 기타 화분' — 0개는 뺌. 없으면 '' */
export function itemsText(i: Items): string {
  const parts = [
    i.document && `서류 ${i.document}`,
    i.small && `소 ${i.small}`,
    i.medium && `중 ${i.medium}`,
    i.big && `대 ${i.big}`,
    i.other && `기타 ${i.other}`,
  ].filter(Boolean)
  return parts.join(', ')
}

/** '1,234원' */
export const won = (n: number | null | undefined) => (n == null ? '' : `${fmtNum(n)}원`)
