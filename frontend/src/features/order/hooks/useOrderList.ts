import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { pageCount } from '@/shared/api/paging'
import { downloadCsv, toCsv } from '@/shared/lib/csv'
import { todayYmd } from '@/shared/lib/dateRange'
import { fmtListTime, fmtPhone } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import type { Option, TagKind } from '@/shared/ui'
import { ORDER_STATUS_LABEL, ORDER_STATUS_TAG } from '@/features/order/labels'
import {
  BOX_TYPES,
  fetchAllOrders,
  orderQueries,
  type OrderListQuery,
  type OrderRow,
  type OrderStatus,
  type Party,
} from '@/features/order/api/orderApi'

export interface PartyCell {
  name: string
  phone: string // 010-1234-5678
  address: string
}

/** 목록 한 줄 = 화면용 글만 (그리기만 하도록) */
export interface OrderListRow {
  orderSeq: number
  canOpen: boolean // 접수 중은 아직 주문 상세가 없어 안 열림
  statusLabel: string
  statusTag: TagKind
  receivedAt: string[] // 올해면 한 줄, 다른 해면 날짜 · 시각 두 줄
  sender: PartyCell
  receiver: PartyCell
  pickupAt: string | null // null = 접수 중이거나 비워 둔 수기 접수 → '—'
  items: string | null // '소박스 1 · 중박스 1'
}

type StatusFilter = OrderStatus | 'ALL'
/** 지금 떠 있는 창 하나 (컨벤션 6.3: 불리언 여러 개 대신 구분 유니온). 수정은 상세에서만 들어가고 끝나면 상세로 돌아감 */
type Modal =
  | { kind: 'add' }
  | { kind: 'csv' }
  | { kind: 'detail'; id: number }
  | { kind: 'edit'; id: number }
  | null

const PAGE_SIZE = 20
// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). from · to가 비면 오늘
const DEFAULTS = { q: '', from: '', to: '', status: 'ALL' }
// 상태 칩 = 전체 + 와이어프레임 03 순서
const STATUS_ORDER: OrderStatus[] = ['IN_PROGRESS', 'PAYMENT_PENDING', 'PAID', 'CANCELLED']
const STATUS_OPTIONS: Option<StatusFilter>[] = [
  { value: 'ALL', label: '전체' },
  ...STATUS_ORDER.map((s) => ({ value: s, label: ORDER_STATUS_LABEL[s] })),
]

const party = (p: Party): PartyCell => ({
  name: p.name,
  phone: fmtPhone(p.phoneNumber),
  address: [p.roadAddress, p.detailAddress].filter(Boolean).join(' '),
})
/** '소박스 1 · 중박스 1 · 기타 화분' — 0개는 뺌. 접수 중(품목 없음)이면 null */
function itemsText(o: OrderRow) {
  if (!o.items) return null
  const items = o.items
  const parts = BOX_TYPES.filter((b) => items[b.key] > 0).map((b) => `${b.label} ${items[b.key]}`)
  if (items.other) parts.push(`기타 ${items.other}`)
  return parts.join(' · ') || null
}

/** 03 주문 내역 훅 (와이어프레임 03_주문내역, 10/31)
 * 검색(이름 · 전화번호 · 주소, 숫자만 치면 주문 번호도) · 날짜 칸(기본 오늘) · 상태 칩 · 쪽은 URL에. CSV 내보내기 = 지금 조건의 전체 쪽 */
export function useOrderList() {
  const { params, page, set } = useListParams(DEFAULTS)
  const [exporting, setExporting] = useState(false)
  const [modal, setModal] = useState<Modal>(null)

  const today = todayYmd()
  const range = params.from ? { from: params.from, to: params.to || params.from } : null
  // URL은 누구나 고칠 수 있으니 모르는 상태 값은 '전체'로 (컨벤션 4.7)
  const status = STATUS_OPTIONS.some((o) => o.value === params.status)
    ? (params.status as StatusFilter)
    : 'ALL'
  const query: OrderListQuery = {
    q: params.q,
    from: range?.from ?? today,
    to: range?.to ?? today,
    status,
  }
  const list = useQuery(orderQueries.list(query, page, PAGE_SIZE))
  const total = list.data?.totalCount ?? 0

  const rows: OrderListRow[] = (list.data?.items ?? []).map((o) => ({
    orderSeq: o.orderSeq,
    canOpen: o.status !== 'IN_PROGRESS',
    statusLabel: ORDER_STATUS_LABEL[o.status],
    statusTag: ORDER_STATUS_TAG[o.status],
    receivedAt: fmtListTime(o.receivedAt),
    sender: party(o.sender),
    receiver: party(o.receiver),
    pickupAt: o.pickupAt && fmtListTime(o.pickupAt).join(' '),
    items: itemsText(o),
  }))

  const exportCsv = async () => {
    setExporting(true)
    try {
      const all = await fetchAllOrders(query)
      const csv = toCsv(
        [
          '주문 번호',
          '상태',
          '접수 시각',
          '보내는 분',
          '보내는 분 전화번호',
          '보내는 분 주소',
          '받는 분',
          '받는 분 전화번호',
          '받는 분 주소',
          '수거 희망 일시',
          '품목',
        ],
        all.map((o) => [
          o.orderSeq,
          ORDER_STATUS_LABEL[o.status],
          fmtListTime(o.receivedAt).join(' '),
          o.sender.name,
          fmtPhone(o.sender.phoneNumber),
          party(o.sender).address,
          o.receiver.name,
          fmtPhone(o.receiver.phoneNumber),
          party(o.receiver).address,
          o.pickupAt ? fmtListTime(o.pickupAt).join(' ') : '',
          itemsText(o) ?? '',
        ]),
      )
      const span = query.from === query.to ? query.from : `${query.from}_${query.to}`
      downloadCsv(`주문내역_${span}.csv`, csv)
    } finally {
      setExporting(false)
    }
  }

  return {
    q: params.q,
    setQ: (v: string) => set({ q: v }),
    range, // 날짜 칸 (null = 오늘)
    setRange: (r: { from: string; to: string }) =>
      // 오늘 하루를 고르면 기본값(빈 값)으로 → 주소가 깨끗하고 내일 열어도 '오늘'
      set(r.from === today && r.to === today ? { from: '', to: '' } : { from: r.from, to: r.to }),
    status,
    statusOptions: STATUS_OPTIONS,
    setStatus: (s: StatusFilter) => set({ status: s }),

    rows,
    count: total, // '주문 목록 104건'
    isLoading: list.isPending,
    listError: list.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,
    page,
    pages: pageCount(total, PAGE_SIZE),
    goPage: (p: number) => set({ page: p }),

    exportCsv,
    exporting,
    canExport: total > 0,

    modal,
    openAdd: () => setModal({ kind: 'add' }),
    openCsv: () => setModal({ kind: 'csv' }),
    openOrder: (r: OrderListRow) => r.canOpen && setModal({ kind: 'detail', id: r.orderSeq }),
    editOrder: (id: number) => setModal({ kind: 'edit', id }), // 상세 창 [수정]
    // 수정 저장 · 취소 → 수정하던 그 주문 상세로
    backToDetail: () => setModal((m) => (m?.kind === 'edit' ? { kind: 'detail', id: m.id } : null)),
    closeModal: () => setModal(null),
  }
}
