// 03 주문 CSV 내보내기 — 목록 한 줄(배송 상세) → CSV 칸. React를 모르는 순수 함수 (실행해서 확인: orderCsv.test.ts)
// 주소 · 상세주소를 나누고 품목은 숫자 열로 → 엑셀에서 바로 합계 · 필터 (10/31)
// 11/01 결정 A: 목록 응답에 있는 칸만 — 물품 가액 · 결제 방식 · 요청 사항은 목록에 없어 뺌(상세 N번 요청은 과함)
import { toDateTimeLocal } from '@/shared/lib/format'
import type { ListParty } from './orderApi'
import type { ParcelRow } from './parcelRows'

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
  '수거 희망 일시',
] as const

/** CSV 날짜 모양 '2026-11-02 09:00' (연도 포함 — 엑셀이 날짜로 알아봄) */
const csvDateTime = (iso: string) => toDateTimeLocal(new Date(iso)).replace('T', ' ')

const party = (p: ListParty | undefined) => [
  p?.name ?? '',
  p?.phoneNumber ?? '',
  p?.roadAddress ?? '',
  p?.detailAddress ?? '',
]

/** 한 줄 → ORDER_CSV_HEADER 순서의 칸. 값이 없으면 빈칸 (접수 중은 이름 · 주소가 비어 있을 수 있음) */
export function toOrderCsvRow(r: ParcelRow, statusLabel: string): string[] {
  const p = r.parcel
  return [
    String(r.orderSeq),
    statusLabel,
    csvDateTime(r.createdAt),
    ...party(p?.origin),
    ...party(p?.destination),
    p ? String(p.documentCount) : '',
    p ? String(p.smallBoxCount) : '',
    p ? String(p.mediumBoxCount) : '',
    p ? String(p.bigBoxCount) : '',
    p?.otherItemDescription ?? '',
    r.pickupRequestedAt ? csvDateTime(r.pickupRequestedAt) : '',
  ]
}
