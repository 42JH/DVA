import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { todayYmd, type Ymd } from '@/shared/lib/dateRange'
import { fmtRowTime } from '@/shared/lib/format'
import { useDayFeed } from '@/shared/lib/useDayFeed'
import { useListParams } from '@/shared/lib/useListParams'
import { ORDER_GROUP, orderNo, type OrderGroup } from '@/shared/order/labels'
import { STATUS_GROUP_LABEL, orderErrorText } from '@/features/order/labels'
import { parcelRows, partyHas, type ParcelRow } from '@/features/order/api/parcelRows'
import {
  cancelOrder,
  fetchOrderDay,
  orderQueries,
  prevOrderDay,
  nextOrderDay,
  retryOrder,
  type ListParty,
  type OrderStatus,
  type StatusGroup,
} from '@/features/order/api/orderApi'

/** 목록 한 줄 = 배송 상세 하나(보내는 분 1 + 받는 분 1, 11/01 결정) · 화면용 글만 (Figma '주문' 11/04) */
export interface OrderListRow {
  key: string
  day: Ymd // 접수한 날 (머리 날짜 · 스크롤 위치)
  orderSeq: number // 줄을 누르면 이 주문 상세 (미완료 · 취소도 열림, 11/01 결정)
  parcelSeq: number | null // 그 줄의 배송 상세 → 상세 창이 이 상세를 보여 줌 (상세 없는 주문은 null)
  time: string // 오늘 '오후 3:02' · 지난 날 '11.03 17:24'
  group: OrderGroup // 상태 칩
  sender: { name: string; address: string }
  receiver: { name: string; address: string }
  orderNo: string // 'DV-10519'
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
  SUBMITTING_FAILED: '다시 접수했지만 실패해서 서버가 자동으로 다시 시도하는 중이에요.',
  SUBMISSION_FAILED: '다시 접수했지만 또 실패했습니다. 백엔드 담당자에게 알려 주세요.',
}

// 더 바뀌지 않는 상태 — 지난 날 목록은 이 밖의 주문이 있을 때만 15초마다 다시 받음 (11/05 사용자)
// 최종 실패는 관리자가 [다시 접수]할 때만 바뀌고, 그땐 무효화로 바로 새로 받음
const DONE: ReadonlySet<OrderStatus> = new Set(['ACCEPTED', 'CANCELLED', 'SUBMISSION_FAILED'])

// URL 쿼리 기본값 (useListParams 규칙: 모듈 상수) — 상세 창을 닫아도 · 새로고침해도 날짜 · 조건 그대로
// date '' = 오늘 · status = 상태 묶음 · q = 검색어 (11/05 사용자: 공용 상단바 검색 한 칸 — 보내는 분 · 받는 분 둘 다에서 찾음)
const DEFAULTS = { date: '', status: 'ALL', q: '' }
const GROUPS = Object.keys(STATUS_GROUP_LABEL) as StatusGroup[]

// 미완료 주문은 이름 · 주소가 아직 비어 있을 수 있음 → 빈 글자 (칸에서 '—')
const party = (p: ListParty | undefined) => ({
  name: p?.name ?? '',
  address: [p?.roadAddress, p?.detailAddress].filter(Boolean).join(' '),
})

const toRow = (r: ParcelRow, day: Ymd, today: Ymd): OrderListRow => ({
  key: r.key,
  day,
  orderSeq: r.orderSeq,
  parcelSeq: r.parcel?.orderParcelSeq ?? null,
  time: fmtRowTime(r.createdAt, today),
  group: ORDER_GROUP[r.status],
  sender: party(r.parcel?.origin),
  receiver: party(r.parcel?.destination),
  orderNo: orderNo(r.orderSeq),
})

/** 그 사람이 맞는 줄만 — 서버 검색어는 하나라 칸마다 그 사람에서 다시 거름 */
// 서버는 주문 단위로 찾음 → 배송 상세 줄마다 보내는 분 · 받는 분 중 한쪽이라도 맞는지 다시 거름
const fits = (q: string) => (r: ParcelRow) =>
  partyHas(r.parcel?.origin, q) || partyHas(r.parcel?.destination, q)

/** 03 주문 내역 훅 (Figma '주문' 11/04) — 고른 날짜(기본 오늘)부터 하루씩 무한 스크롤, 오늘은 5초마다 새로 (04 통화와 같은 틀)
 *  거르기: 주문 상태(서버 statusGroup) · 보내는 분 · 받는 분 검색칸. 줄을 누르면 주문 상세 창 → 수정 · 취소 · 다시 접수 */
export function useOrderList() {
  const { params, set } = useListParams(DEFAULTS)
  const [modal, setModal] = useState<Modal>(null)
  const [notice, setNotice] = useState<string | null>(null) // 취소 · 다시 접수 결과 한 줄
  const qc = useQueryClient()

  const today = todayYmd()
  const anchor =
    /^\d{4}-\d{2}-\d{2}$/.test(params.date) && params.date < today ? params.date : today
  // URL은 누구나 고칠 수 있으니 모르는 상태 값은 '전체'로 (컨벤션 4.7)
  const group = GROUPS.includes(params.status as StatusGroup)
    ? (params.status as StatusGroup)
    : 'ALL'
  const q = params.q.trim()
  const filter = { q, group }
  const feed = useDayFeed({
    key: [...orderQueries.all(), 'list'],
    filter,
    anchor,
    fetchDay: (day, signal) => fetchOrderDay(day, filter, signal),
    prevDay: (day, signal) => prevOrderDay(day, filter, signal),
    nextDay: (day, signal) => nextOrderDay(day, filter, signal),
    pending: (r) => !DONE.has(r.status),
  })
  const days = feed.days.map(({ day, rows }) => ({
    day,
    rows: rows
      .flatMap(parcelRows)
      .filter(fits(q))
      .map((r) => toRow(r, day, today)),
  }))

  // 취소 · 다시 접수 — 확인 창 [확인] → 요청 → 목록 · 상세 다시 받기 → 그 줄의 상세로 돌아감
  const action = useMutation({
    mutationFn: async (m: Extract<Modal, { kind: 'cancel' | 'retry' }>) => {
      if (m.kind === 'cancel') {
        await cancelOrder(m.id)
        return `${orderNo(m.id)} 주문을 취소했습니다.`
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

  return {
    anchor,
    feed: { ...feed, days },
    setDate: (d: Ymd) => set({ date: d >= today ? '' : d }),

    group,
    groups: GROUPS.map((g) => ({ value: g, label: STATUS_GROUP_LABEL[g] })),
    setGroup: (g: StatusGroup) => set({ status: g }),

    q: params.q,
    // 검색하면 오늘부터 (최근 주문이 위) — 지난 날짜에 머물러 있으면 새 결과가 안 보임. 같은 값이면 그대로
    setQ: (v: string) => {
      if (v.trim() !== q) set({ q: v.trim(), date: '' })
    },
    isFiltered: group !== 'ALL' || !!q,

    modal,
    openAdd: () => setModal({ kind: 'add' }),
    openOrder: (r: OrderListRow) =>
      setModal({ kind: 'detail', id: r.orderSeq, parcelSeq: r.parcelSeq }),
    // 상단바 검색에서 고른 주문 — 이 화면의 상세 창(수정 · 취소 가능)으로, 첫 배송 상세
    openOrderSeq: (id: number) => setModal({ kind: 'detail', id, parcelSeq: null }),
    editOrder: (id: number) =>
      setModal((m) => ({ kind: 'edit', id, parcelSeq: m?.kind === 'detail' ? m.parcelSeq : null })), // 상세 창 [수정]
    // 수정 저장 · 취소 → 수정하던 그 주문 상세로. notice = 미완료 주문 접수 결과 (머리 한 줄)
    backToDetail: (message?: string) => {
      if (message) setNotice(message)
      setModal((m) =>
        m?.kind === 'edit' ? { kind: 'detail', id: m.id, parcelSeq: m.parcelSeq } : null,
      )
    },
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
