import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { pageCount } from '@/shared/api/paging'
import { downloadCsv, toCsv } from '@/shared/lib/csv'
import { todayYmd } from '@/shared/lib/dateRange'
import { fmtListTime, fmtPhone } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import type { Option, TagKind } from '@/shared/ui'
import {
  ORDER_STATUS_LABEL,
  ORDER_STATUS_TAG,
  STATUS_GROUP_LABEL,
  orderErrorText,
} from '@/features/order/labels'
import { ORDER_CSV_HEADER, toOrderCsvRow } from '@/features/order/api/orderCsv'
import { parcelRows, type ParcelRow } from '@/features/order/api/parcelRows'
import {
  BOX_TYPES,
  fetchAllOrders,
  orderQueries,
  type ListParcel,
  type ListParty,
  type OrderListQuery,
  type StatusGroup,
  cancelOrder,
  retryOrder,
} from '@/features/order/api/orderApi'

export interface PartyCell {
  name: string
  phone: string // 010-1234-5678
  address: string
}

/** 목록 한 줄 = 배송 상세 하나(보내는 분 1 + 받는 분 1, 11/01 결정) · 화면용 글만 (그리기만 하도록) */
export interface OrderListRow {
  key: string
  orderSeq: number // 줄을 누르면 이 주문 상세 (접수 중단 · 취소도 열림, 11/01 결정)
  parcelSeq: number | null // 그 줄의 배송 상세 → 상세 창이 이 상세를 보여 줌 (상세 없는 주문은 null)
  statusLabel: string
  statusTag: TagKind
  receivedAt: string[] // 올해면 한 줄, 다른 해면 날짜 · 시각 두 줄
  sender: PartyCell
  receiver: PartyCell
  pickupAt: string | null // null = 접수 중이거나 비워 둔 수기 접수 → '—'
  items: string | null // '소박스 1 · 중박스 1'
}

type Modal =
  | { kind: 'add' }
  | { kind: 'detail'; id: number; parcelSeq: number | null }
  | { kind: 'edit'; id: number; parcelSeq: number | null } // 끝나면 같은 줄의 상세로 돌아가려고 같이 기억
  | { kind: 'cancel'; id: number; parcelSeq: number | null; parcelCount: number } // 취소 확인 창 (상세 창 대신)
  | { kind: 'retry'; id: number; parcelSeq: number | null } // 다시 접수 확인 창
  | null

// 다시 접수 결과 (응답 status) → 목록 위 안내. 201/200이어도 다시 실패할 수 있음
const RETRY_RESULT: Partial<Record<string, string>> = {
  ACCEPTED: '디버에 다시 접수했습니다.',
  SUBMITTING: '디버 접수를 처리하는 중이에요. 잠시 뒤 목록에서 확인해 주세요.',
  SUBMISSION_FAILED: '다시 접수했지만 또 실패했습니다. 백엔드 담당자에게 알려 주세요.',
}

const PAGE_SIZE = 20 // 주문 20개 — 상세가 여러 개면 줄은 더 많아짐
// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). from · to가 비면 오늘
const DEFAULTS = { q: '', from: '', to: '', status: 'ALL' }
const SEARCH_DELAY_MS = 300 // 서버 검색 — 멈추고 0.3초 뒤 (기업 목록과 같음)
// 상태 탭 5개 = 서버 statusGroup
const STATUS_OPTIONS: Option<StatusGroup>[] = (
  Object.keys(STATUS_GROUP_LABEL) as StatusGroup[]
).map((g) => ({ value: g, label: STATUS_GROUP_LABEL[g] }))

// 접수 중은 이름 · 전화 · 주소가 아직 비어 있을 수 있음 → 빈 글자 (칸에서 '—')
const party = (p: ListParty | undefined): PartyCell => ({
  name: p?.name ?? '',
  phone: p?.phoneNumber ? fmtPhone(p.phoneNumber) : '',
  address: [p?.roadAddress, p?.detailAddress].filter(Boolean).join(' '),
})
/** '소박스 1 · 중박스 1 · 기타 화분' — 0개는 뺌. 상세가 없으면 null */
function itemsText(p: ListParcel | null) {
  if (!p) return null
  const count = {
    document: p.documentCount,
    small: p.smallBoxCount,
    medium: p.mediumBoxCount,
    big: p.bigBoxCount,
  }
  const parts = BOX_TYPES.filter((b) => count[b.key] > 0).map((b) => `${b.label} ${count[b.key]}`)
  if (p.otherItemDescription) parts.push(`기타 ${p.otherItemDescription}`)
  return parts.join(' · ') || null
}

/** 03 주문 내역 훅 (와이어프레임 03_주문내역, 10/31 · 실서버 11/01)
 * 검색(이름 · 전화번호 · 주소, 서버) · 날짜 칸(기본 오늘) · 상태 탭 5개 · 쪽은 URL에. 줄 = 배송 상세. CSV = 지금 조건의 전체(목록 칸만) */
export function useOrderList() {
  const { params, page, set } = useListParams(DEFAULTS)
  const [exporting, setExporting] = useState(false)
  const [modal, setModal] = useState<Modal>(null)

  const today = todayYmd()
  const range = params.from ? { from: params.from, to: params.to || params.from } : null
  // URL은 누구나 고칠 수 있으니 모르는 상태 값은 '전체'로 (컨벤션 4.7)
  const status = STATUS_OPTIONS.some((o) => o.value === params.status)
    ? (params.status as StatusGroup)
    : 'ALL'
  // 검색칸은 바로(URL), 요청은 멈춘 뒤에
  const [searched, setSearched] = useState(params.q)
  useEffect(() => {
    const t = setTimeout(() => setSearched(params.q), SEARCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [params.q])
  const query: OrderListQuery = {
    q: searched,
    from: range?.from ?? today,
    to: range?.to ?? today,
    group: status,
  }
  const list = useQuery(orderQueries.list(query, page, PAGE_SIZE))
  const qc = useQueryClient()
  const [notice, setNotice] = useState<string | null>(null) // 취소 · 다시 접수 결과 한 줄

  // 취소 · 다시 접수 — 확인 창 [확인] → 요청 → 목록 · 상세 다시 받기 → 그 줄의 상세로 돌아감
  const action = useMutation({
    mutationFn: async (m: Extract<Modal, { kind: 'cancel' | 'retry' }>) => {
      if (m.kind === 'cancel') {
        await cancelOrder(m.id)
        return `주문 ${m.id}번을 취소했습니다.`
      }
      const res = await retryOrder(m.id)
      return (
        RETRY_RESULT[res.data?.status ?? ''] ??
        '다시 접수를 요청했습니다. 목록에서 상태를 확인해 주세요.'
      )
    },
    onSuccess: async (message, m) => {
      await qc.invalidateQueries({ queryKey: orderQueries.all() })
      setNotice(message)
      setModal({ kind: 'detail', id: m.id, parcelSeq: m.parcelSeq })
    },
  })
  const total = list.data?.total_count ?? 0 // 주문 수 (줄 수 아님)

  const rows: OrderListRow[] = (list.data?.data ?? []).flatMap(parcelRows).map((r) => ({
    key: r.key,
    orderSeq: r.orderSeq,
    parcelSeq: r.parcel?.orderParcelSeq ?? null,
    statusLabel: ORDER_STATUS_LABEL[r.status],
    statusTag: ORDER_STATUS_TAG[r.status],
    receivedAt: fmtListTime(r.createdAt),
    sender: party(r.parcel?.origin),
    receiver: party(r.parcel?.destination),
    pickupAt: r.pickupRequestedAt && fmtListTime(r.pickupRequestedAt).join(' '),
    items: itemsText(r.parcel),
  }))

  const exportCsv = async () => {
    setExporting(true)
    try {
      const all: ParcelRow[] = (await fetchAllOrders(query)).flatMap(parcelRows)
      const csv = toCsv(
        [...ORDER_CSV_HEADER],
        all.map((r) => toOrderCsvRow(r, ORDER_STATUS_LABEL[r.status])),
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
    setStatus: (s: StatusGroup) => set({ status: s }),

    rows,
    count: total, // '주문 목록 104건' — 주문 수
    isLoading: list.isPending,
    listError: list.error ? '주문 목록을 불러오지 못했습니다. 새로고침해 주세요.' : null,
    page,
    pages: pageCount(total, PAGE_SIZE),
    goPage: (p: number) => set({ page: p }),

    exportCsv,
    exporting,
    canExport: total > 0,

    modal,
    openAdd: () => setModal({ kind: 'add' }),
    openOrder: (r: OrderListRow) =>
      setModal({ kind: 'detail', id: r.orderSeq, parcelSeq: r.parcelSeq }),
    editOrder: (id: number) =>
      setModal((m) => ({ kind: 'edit', id, parcelSeq: m?.kind === 'detail' ? m.parcelSeq : null })), // 상세 창 [수정]
    // 수정 저장 · 취소 → 수정하던 그 주문 상세로
    backToDetail: () =>
      setModal((m) =>
        m?.kind === 'edit' ? { kind: 'detail', id: m.id, parcelSeq: m.parcelSeq } : null,
      ),
    closeModal: () => setModal(null),
    // 상세 창 [주문 취소] · [다시 접수] → 확인 창 (상세 창 대신 띄움 — 겹치면 Esc가 둘 다 닫음)
    askCancel: (id: number, parcelCount: number) =>
      setModal((m) => ({
        kind: 'cancel',
        id,
        parcelCount,
        parcelSeq: m?.kind === 'detail' ? m.parcelSeq : null,
      })),
    askRetry: (id: number) =>
      setModal((m) => ({
        kind: 'retry',
        id,
        parcelSeq: m?.kind === 'detail' ? m.parcelSeq : null,
      })),
    // 확인 창 [취소] → 그 상세로
    backFromConfirm: () =>
      setModal((m) =>
        m?.kind === 'cancel' || m?.kind === 'retry'
          ? { kind: 'detail', id: m.id, parcelSeq: m.parcelSeq }
          : m,
      ),
    confirmAction: () =>
      (modal?.kind === 'cancel' || modal?.kind === 'retry') && action.mutate(modal),
    acting: action.isPending,
    actionError: action.error
      ? orderErrorText(action.error, modal?.kind === 'cancel' ? '취소' : '접수')
      : null,
    notice,
  }
}
