// v2 주문 목록 — 쪽 번호(기준 시각 고정, useSnapshotList) + 새 주문 알림 + 상태 묶음별 건수 + 기간 · 검색. 서버 API는 기존과 같음 (GET /admin/orders)
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { draftList, draftListItem } from '@/features/order/api/draftApi'
import { oldestPage, usePageSize } from '@/v2/lib/paging'
import { api, type ApiList } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { useDebounced } from '@/v2/lib/useDebounced'
import { phoneDigits } from '@/shared/lib/search'
import type { OrderListItem, StatusGroup } from '@/features/order/api/orderApi'
import { parcelRows } from '@/features/order/api/parcelRows'
import { orderNo } from '@/shared/order/labels'
import { orderQueries } from '@/shared/order/orderApi'
import { useSnapshotList } from '@/v2/lib/useSnapshotList'
import { rangeFrom, type Range } from '@/v2/lib/range'
import { itemsText, STATUS_LOOK } from './orderLook'
import { dateTime } from '@/v2/lib/when'

export const GROUPS: { value: StatusGroup; label: string }[] = [
  { value: 'ALL', label: '전체' },
  { value: 'COLLECTING', label: '미완료' },
  { value: 'notPaid', label: '결제 대기' },
  { value: 'PAID', label: '결제 완료' },
  { value: 'SUBMISSION_FAILED', label: '접수 실패' },
  { value: 'CANCELLED', label: '주문 취소' },
]
// at = 목록 기준 시각 (useSnapshotList) — 조건을 바꾸면 '' 로 지워 지금 최신 · 첫 쪽으로
// o = 열어 둔 주문 '주문번호' 또는 '주문번호-배송번호' (통화 상세의 주문 링크도 이걸로 엶) · 미완료(배송 초안)는 'd초안번호'
// d = 접수 시각 정렬 ('asc' = 오래된 순)
const DEFAULTS = { q: '', g: 'ALL', r: '7d', at: '', o: '', d: 'desc' }

const party = (p: { name: string | null; phoneNumber: string | null } | undefined) => ({
  name: p?.name ?? '',
  phone: p?.phoneNumber ? fmtPhone(p.phoneNumber) : '',
})

export function useOrders() {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  const g = params.g as StatusGroup
  const r = params.r as Range
  const asc = params.d === 'asc'
  const t = useDebounced(params.q.trim()) // 입력이 멈추면 한 번만 서버에
  const base = {
    q: (phoneDigits(t) || t).slice(0, 200) || undefined,
    from: rangeFrom(r),
  }
  const query = { ...base, statusGroup: g === 'ALL' ? undefined : g }
  const [os, ps] = params.o.split('-').map(Number)
  const picked = params.o.startsWith('d')
    ? { orderSeq: -Number(params.o.slice(1)), parcelSeq: null } // 배송 초안 = 음수 번호
    : os
      ? { orderSeq: os, parcelSeq: ps || null }
      : null

  const list = useSnapshotList<OrderListItem>({
    key: 'orders',
    path: '/admin/orders',
    query,
    at: (o) => o.createdAt,
    page,
    asOf: params.at,
    go: set,
    asc,
  })
  // 미완료 = 배송 초안 (055 — 새 AI 접수 · 이관된 옛 미완료는 주문이 아님). 기간 조건 없음, 쪽 번호만
  const drafting = g === 'COLLECTING'
  const [size, setSize] = usePageSize()
  const draftCount = useQuery({
    queryKey: ['v2', 'drafts', 'count', base.q],
    queryFn: ({ signal }) =>
      draftList({ q: base.q, limit: 1, offset: 0 }, signal).then((r) => r.total_count),
  })
  // 오래된 순이면 총 건수로 뒤쪽부터 (oldestPage)
  const dn = draftCount.data ?? 0
  const drafts = useQuery({
    queryKey: ['v2', 'drafts', base.q, size, page, asc ? dn : 'desc'],
    enabled: drafting && (!asc || draftCount.data !== undefined),
    queryFn: ({ signal }) => {
      const get = (limit: number, offset: number) => draftList({ q: base.q, limit, offset }, signal)
      return asc ? oldestPage(dn, page, size, get) : get(size, (page - 1) * size)
    },
    placeholderData: keepPreviousData,
  })
  const draftItems = (drafts.data?.data ?? []).map(draftListItem)
  const draftLabels = new Map(draftItems.map((d) => [d.orderSeq, d.label]))
  const shown = drafting
    ? {
        items: draftItems as OrderListItem[],
        isLoading: drafts.isPending,
        isStale: drafts.isPlaceholderData,
        error: drafts.error ? '불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' : null,
        total: drafts.data?.total_count ?? 0,
        page,
        size,
        setPage: (p: number) => set({ page: p }),
        setSize,
        fresh: 0,
        latest: () => {},
      }
    : list
  const to = list.asOf ? new Date(list.asOf).toISOString() : undefined
  // 묶음마다 건수 — 1건만 받아 total_count (검색 · 기간 · 목록 기준 시각은 같이 적용 → 탭 건수와 아래 총 건수가 같음)
  const counts = useQueries({
    queries: GROUPS.map((x) => ({
      queryKey: ['v2', 'orders', 'count', { ...base, to, statusGroup: x.value }],
      enabled: !!to && x.value !== 'COLLECTING', // 미완료 건수는 초안에서
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api
          .get<ApiList<OrderListItem>>('/admin/orders', {
            query: {
              ...base,
              to,
              statusGroup: x.value === 'ALL' ? undefined : x.value,
              limit: 1,
              offset: 0,
            },
            signal,
          })
          .then((res) => res.total_count),
    })),
  })

  const rows = shown.items.flatMap(parcelRows).map((row) => {
    const p = row.parcel
    return {
      key: row.key,
      orderSeq: row.orderSeq,
      parcelSeq: p?.orderParcelSeq ?? null,
      no: draftLabels.get(row.orderSeq) ?? orderNo(row.orderSeq),
      look: STATUS_LOOK[row.status],
      incomplete: row.status === 'COLLECTING',
      createdAt: dateTime(row.createdAt),
      pickupAt: dateTime(row.pickupRequestedAt),
      sender: { ...party(p?.origin), address: p?.origin.roadAddress ?? '' },
      receiver: { ...party(p?.destination), address: p?.destination.roadAddress ?? '' },
      items: p
        ? itemsText({
            document: p.documentCount,
            small: p.smallBoxCount,
            medium: p.mediumBoxCount,
            big: p.bigBoxCount,
            other: p.otherItemDescription,
          })
        : '',
    }
  })

  return {
    q: params.q,
    setQ: (q: string) => set({ q, at: '' }),
    group: g,
    groups: GROUPS.map((x, i) => ({
      ...x,
      count: x.value === 'COLLECTING' ? (draftCount.data ?? null) : (counts[i].data ?? null),
    })),
    ranged: !drafting, // 미완료(초안)는 기간 조건이 없음
    setGroup: (v: StatusGroup) => set({ g: v, at: '' }),
    range: r,
    asc,
    toggleSort: () => set({ d: asc ? 'desc' : 'asc' }),
    setRange: (v: Range) => set({ r: v, at: '' }),
    rows,
    list: shown,
    picked,
    // 열고 닫기는 필터가 아님 → 보던 쪽 그대로 (page를 안 넘기면 useListParams가 1쪽으로 되돌림)
    pick: (orderSeq: number, parcelSeq: number | null) =>
      set({
        o:
          orderSeq < 0
            ? `d${-orderSeq}`
            : parcelSeq
              ? `${orderSeq}-${parcelSeq}`
              : String(orderSeq),
        page,
      }),
    unpick: () => set({ o: '', page }),
    // 줄에 마우스를 올리면(키보드로 오면) 상세를 미리 받음 — 누르면 패널이 바로 참
    warm: (orderSeq: number) =>
      void qc.prefetchQuery({ ...orderQueries.detail(orderSeq), staleTime: 30_000 }),
  }
}

export type OrdersVm = ReturnType<typeof useOrders>
export type OrderRow = OrdersVm['rows'][number]
