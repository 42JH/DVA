// 03 주문 CSV 내보내기 — 주문 한 줄 → CSV 칸. React를 모르는 순수 함수 (실행해서 확인: orderCsv.test.ts)
// 주소 · 상세주소를 나누고 품목은 숫자 열로 → 엑셀에서 바로 합계 · 필터 (10/31)
// (CSV로 추가는 10/31 뺌: 주문은 대부분 AI 상담사가 받고, 사람이 대량으로 넣을 일이 드묾)
import { toDateTimeLocal } from '@/shared/lib/format'
import { PAYMENT_METHOD_LABEL } from '@/shared/order/labels'
import type { OrderRow } from './orderApi'

export const ORDER_CSV_HEADER = [
  '주문 번호',
  '상태',
  '접수 시각',
  '보내는 분',
  '보내는 분 전화번호',
  '보내는 분 주소',
  '보내는 분 상세주소',
  '받는 분',
  '받는 분 전화번호',
  '받는 분 주소',
  '받는 분 상세주소',
  '서류',
  '소박스',
  '중박스',
  '대박스',
  '기타 품목',
  '물품 가액',
  '수거 희망 일시',
  '결제 방식',
  '고객 요청 사항',
] as const

/** CSV 날짜 모양 '2026-11-02 09:00' (연도 포함 — 엑셀이 날짜로 알아봄) */
const csvDateTime = (iso: string) => toDateTimeLocal(new Date(iso)).replace('T', ' ')

/** 주문 한 줄 → ORDER_CSV_HEADER 순서의 칸. 값이 없으면 빈칸 (접수 중 줄은 품목 · 결제가 비어 있음) */
export function toOrderCsvRow(o: OrderRow, statusLabel: string): string[] {
  const i = o.items
  return [
    String(o.orderSeq),
    statusLabel,
    csvDateTime(o.receivedAt),
    o.sender.name,
    o.sender.phoneNumber,
    o.sender.roadAddress,
    o.sender.detailAddress ?? '',
    o.receiver.name,
    o.receiver.phoneNumber,
    o.receiver.roadAddress,
    o.receiver.detailAddress ?? '',
    i ? String(i.document) : '',
    i ? String(i.small) : '',
    i ? String(i.medium) : '',
    i ? String(i.big) : '',
    i?.other ?? '',
    o.itemPrice?.toString() ?? '',
    o.pickupAt ? csvDateTime(o.pickupAt) : '',
    o.paymentMethod ? PAYMENT_METHOD_LABEL[o.paymentMethod] : '',
    o.clientComment ?? '',
  ]
}
