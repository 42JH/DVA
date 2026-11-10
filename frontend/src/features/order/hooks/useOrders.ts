// 주문 목록 — 쪽 번호(기준 시각 고정, useSnapshotList) + 새 주문 알림 + 상태 묶음별 건수 + 기간 · 검색. 서버 API는 기존과 같음 (GET /admin/orders)
import { useEffect } from 'react'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { draftList, draftListItem, fromAdminList } from '@/features/order/api/draftApi'
import { oldestPage } from '@/shared/lib/paging'
import { pageCount } from '@/shared/api/paging'
import { api, type ApiList } from '@/shared/api/client'
import { fmtPhone } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { useDebounced } from '@/shared/lib/useDebounced'
import { phoneDigits } from '@/shared/lib/search'
import type { OrderListItem, StatusGroup } from '@/features/order/api/orderApi'
import { parcelRows } from '@/features/order/api/parcelRows'
import { orderNo } from '@/shared/order/labels'
import { orderQueries } from '@/shared/order/orderApi'
import { useSnapshotList } from '@/shared/lib/useSnapshotList'
import { rangeFrom, type Range } from '@/shared/lib/range'
import { itemsText, STATUS_LOOK } from '../../../shared/order/look'
import { dateTime } from '@/shared/lib/when'

// GET /admin/orders statusCounts — all = 실제 주문 + 미완료 초안(057 · 058 뒤), incomplete = 그중 초안
interface StatusCounts {
  all: number
  incomplete: number
  notPaid: number
  paid: number
  submissionFailed: number
  cancelled: number
}
const COUNT_KEY: Record<StatusGroup, keyof StatusCounts> = {
  ALL: 'all',
  COLLECTING: 'incomplete',
  notPaid: 'notPaid',
  PAID: 'paid',
  SUBMISSION_FAILED: 'submissionFailed',
  CANCELLED: 'cancelled',
}

const GROUPS: { value: StatusGroup; label: string }[] = [
  { value: 'ALL', label: '전체' },
  { value: 'COLLECTING', label: '미완료' },
  { value: 'notPaid', label: '결제 대기' },
  { value: 'PAID', label: '결제 · 접수 완료' }, // 서버 묶음 PAID = 결제 완료 · 디버 접수 중 · 접수 완료 (접수 완료만 따로 묶음 없음, 11/10)
  { value: 'SUBMISSION_FAILED', label: '접수 실패' },
  { value: 'CANCELLED', label: '주문 취소' },
]
// o = 열어 둔 주문 '주문번호' 또는 '주문번호-배송번호' (통화 상세의 주문 링크도 이걸로 엶) · 미완료(배송 초안)는 'd초안번호'
// d = 접수 시각 정렬 ('asc' = 오래된 순)
// c = 주문 상세에서 띄운 이어진 통화 번호 (통화 상세에 갔다가 ‹로 돌아오면 그 창 그대로)
// 목록 기준 시각은 주소에 안 둠 (useSnapshotList, 11/10) — 조건을 바꾸거나 화면에 다시 오면 지금 최신으로
const DEFAULTS = { q: '', g: 'ALL', r: '7d', o: '', d: 'desc', c: '' }

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
    resetOn: g, // 탭을 옮기면 새로 들어온 주문까지 (기준 조건엔 탭을 안 넣음 — anchorQuery 설명)
    go: set,
    asc,
    anchorQuery: base, // 모든 상태 탭 · 탭 건수가 같은 기준 시각 (탭 조건을 넣으면 '주문 취소' 탭은 마지막 취소 시각이 기준이 돼 그 뒤 주문이 전체 건수에서 빠졌음)
    enabled: g !== 'COLLECTING', // 미완료 탭은 초안 목록 — 주문 목록 · 쪽 당기기가 초안 쪽을 되돌리지 않게
  })
  // 미완료 = 배송 초안 (055 — 새 AI 접수 · 이관된 옛 미완료는 주문이 아님). 기간 조건 없음, 쪽 번호만
  const drafting = g === 'COLLECTING'
  const { size, setSize } = list // 쪽 크기는 목록과 하나로
  const draftCount = useQuery<number>({
    queryKey: ['screen', 'drafts', 'count', base.q],
    queryFn: ({ signal }) =>
      draftList({ q: base.q, limit: 1, offset: 0 }, signal).then((r) => r.total_count),
    placeholderData: keepPreviousData,
  })
  // 오래된 순이면 총 건수로 뒤쪽부터 (oldestPage)
  const dn = draftCount.data ?? 0
  const drafts = useQuery({
    queryKey: ['screen', 'drafts', base.q, size, page, asc ? dn : 'desc'],
    enabled: drafting && (!asc || draftCount.data !== undefined),
    queryFn: ({ signal }) => {
      const get = (limit: number, offset: number) => draftList({ q: base.q, limit, offset }, signal)
      return asc ? oldestPage(dn, page, size, get) : get(size, (page - 1) * size)
    },
    placeholderData: keepPreviousData,
  })
  // 초안이 줄어 보던 쪽이 없어지면 마지막 쪽으로 (서버 offset이 쪽을 쓰므로 주소도 고침)
  const draftTotal = drafts.data?.total_count ?? 0
  const draftPages = pageCount(draftTotal, size)
  useEffect(() => {
    if (drafting && drafts.data && !drafts.isPlaceholderData && draftTotal > 0 && page > draftPages)
      set({ page: draftPages })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 받은 결과가 바뀔 때만
  }, [drafts.data, page, draftPages])
  const draftItems = (drafts.data?.data ?? []).map(draftListItem)
  const listItems = list.items.map(fromAdminList) // 전체 목록에 섞여 온 초안 줄은 초안으로 엶 (057 · 058 뒤)
  const draftLabels = new Map(
    [...draftItems, ...listItems].flatMap((d) => (d.label ? [[d.orderSeq, d.label] as const] : [])),
  )
  const shown = drafting
    ? {
        items: draftItems as OrderListItem[],
        isLoading: drafts.isPending && !(asc && draftCount.error),
        isStale: drafts.isPlaceholderData,
        error:
          drafts.error || (asc && draftCount.error)
            ? '불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.'
            : null,
        total: draftTotal,
        page: Math.min(page, draftPages),
        size,
        setPage: (p: number) => set({ page: p }),
        setSize,
        fresh: 0,
        latest: () => {},
      }
    : { ...list, items: listItems as OrderListItem[] }
  const to = list.asOf ? new Date(list.asOf).toISOString() : undefined
  // 탭 건수 — 목록 응답의 statusCounts 한 번 (검색 · 기간 · 목록 기준 시각 같이 적용, 서버가 같은 시점으로 셈). 미완료는 아직 초안 목록 건수
  const counts = useQuery<StatusCounts>({
    queryKey: ['screen', 'orders', 'statusCounts', { ...base, to }],
    enabled: !!to,
    placeholderData: keepPreviousData, // 기간 · 검색을 바꿔 새로 받는 동안 숫자를 비우지 않음 (탭이 줄었다 늘며 울렁이던 것)
    queryFn: ({ signal }) =>
      api
        .get<ApiList<OrderListItem> & { statusCounts: StatusCounts }>('/admin/orders', {
          query: { ...base, to, limit: 1, offset: 0 },
          signal,
        })
        .then((res) => res.statusCounts),
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
    setQ: (q: string) => set({ q }),
    group: g,
    groups: GROUPS.map((x) => ({
      ...x,
      count:
        x.value === 'COLLECTING'
          ? (draftCount.data ?? null)
          : (counts.data?.[COUNT_KEY[x.value]] ?? null),
    })),
    ranged: !drafting, // 미완료(초안)는 기간 조건이 없음
    setGroup: (v: StatusGroup) => set({ g: v }),
    range: r,
    asc,
    toggleSort: () => set({ d: asc ? 'desc' : 'asc' }),
    setRange: (v: Range) => set({ r: v }),
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
        c: '', // 다른 주문을 고르면 통화 창은 닫힘
        page,
      }),
    unpick: () => set({ o: '', c: '', page }),
    callSeq: Number(params.c) || null,
    setCall: (seq: number | null) => set({ c: seq ? String(seq) : '', page }),
    // 줄에 마우스를 올리면(키보드로 오면) 상세를 미리 받음 — 누르면 패널이 바로 참
    warm: (orderSeq: number) =>
      void qc.prefetchQuery({ ...orderQueries.detail(orderSeq), staleTime: 30_000 }),
  }
}

export type OrdersVm = ReturnType<typeof useOrders>
export type OrderRow = OrdersVm['rows'][number]
