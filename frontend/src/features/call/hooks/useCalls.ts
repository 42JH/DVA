// 통화 목록 — 쪽 번호(기준 시각 고정, useSnapshotList) + 기간 · 검색. GET /calls 그대로
// 기업 피드백: 통화 번호(#seq) 표기 · 상태(통화 중 · 분석 중 · 분석 실패 · 분석 완료)와 상담 결과(접수 · 조회 · 취소 · FAQ)를 다른 칸으로
import { fmtDuration, fmtPhone } from '@/shared/lib/format'
import { callKinds } from '@/shared/lib/kinds'
import { phoneDigits } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import { useDebounced } from '@/shared/lib/useDebounced'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { toCallRow, type CallListItemDto } from '@/shared/call/callDto'
import { callQueries } from '@/shared/call/callApi'
import { byTarget, TARGET_LABEL } from '@/shared/call/complaints'
import { useSnapshotList } from '@/shared/lib/useSnapshotList'
import { rangeFrom, type Range } from '@/shared/lib/range'
import { dateTime } from '@/shared/lib/when'
import { callState, memberOf, STATE_FILTERS, stateKey, type StateFilter } from '../callState'
import { fetchAll, FETCH_ALL_MAX, pageCount } from '@/shared/api/paging'
import { orderNo } from '@/shared/order/labels'

// at = 목록 기준 시각 · d = 시작 시각 정렬('asc' = 오래된 순) · s = 상태 필터(STATE_FILTERS). 불만 필터는 뺌 (상태와 겹쳐 골라져 불편, 불만은 표의 칩으로)
const DEFAULTS = { q: '', r: '7d', s: '', d: 'desc' } // 목록 기준 시각은 주소에 안 둠 (useSnapshotList, 11/10)

/** 통화 상태 — 끝났는지(PBX 종료 시각)와 분석이 왔는지로 */

export function useCalls() {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  const r = params.r as Range
  const asc = params.d === 'asc'
  const t = useDebounced(params.q.trim()) // 입력이 멈추면 한 번만 서버에
  const query = { q: (phoneDigits(t) || t).slice(0, 200) || undefined, from: rangeFrom(r) }
  const s = (STATE_FILTERS.some((f) => f.value === params.s) ? params.s : '') as StateFilter

  const list = useSnapshotList<CallListItemDto>({
    key: 'calls',
    path: '/calls',
    query,
    at: (c) => c.startedAt,
    page,
    go: set,
    resetOn: params.s, // 상태 필터를 바꾸면 새로 들어온 통화까지
    asc,
  })

  // 상태 필터: 서버에 분석 상태 조건이 없어 그 기간 · 검색의 통화를 모두 받아 화면에서 거르고 쪽을 나눔
  // ponytail: 최대 2,000건(FETCH_ALL_MAX). 백엔드가 GET /calls?analysisStatus를 주면 그 조건으로 바꾸고 이 덩어리를 지움
  const { size, setSize } = list // 쪽 크기는 목록과 하나로 (따로 두면 상태를 바꿀 때 크기가 어긋남)
  const to = list.asOf ? new Date(list.asOf).toISOString() : undefined
  const all = useQuery({
    queryKey: ['screen', 'calls', 'all', query, to],
    enabled: !!s && !!to,
    queryFn: ({ signal }) => fetchAll<CallListItemDto>('/calls', { ...query, to }, signal),
    staleTime: Infinity, // 기준 시각에 묶임 — 새 통화는 [최신 목록 보기]로만
    refetchInterval: 15_000, // 받은 통화의 상태(통화 중 → 분석 중 → 분석 완료)는 15초마다 새로
    placeholderData: keepPreviousData,
  })
  const hit = (all.data ?? []).filter((d) => stateKey(callState(d).label) === s)
  if (asc) hit.reverse() // 서버는 최신순
  const pg = Math.min(page, pageCount(hit.length, size)) // 걸러진 수가 줄면 마지막 쪽으로
  const shown = s
    ? {
        items: hit.slice((pg - 1) * size, pg * size),
        isLoading: all.isPending && !list.error,
        isStale: all.isPlaceholderData,
        error: all.error || list.error ? '불러오지 못했습니다. 잠시 뒤 다시 시도해 주세요.' : null,
        total: hit.length,
        page: pg,
        size,
        setPage: (p: number) => set({ page: p }),
        setSize,
        fresh: list.fresh,
        latest: list.latest,
      }
    : list

  const rows = shown.items.map((d) => {
    const row = toCallRow(d)
    return {
      seq: d.callSessionSeq,
      state: callState(d),
      startedAt: dateTime(d.startedAt),
      name: row.customerName ?? '',
      isNew: row.isNew === true,
      kind: d.organizationName ? '기업' : memberOf(d), // 목록은 구분만 — 기업명은 통화 상세에서
      phone: row.callerNumber ? fmtPhone(row.callerNumber) : '',
      kinds: callKinds(row.counts),
      analyzed: row.counts !== null,
      // 고객 불만 칩 — 대상마다 하나, 전부 보임 (AI 응대 오류는 목록에서 빼고 상세 · 통계로, +N 없이). 근거는 그 대상의 첫 말
      complaints: byTarget(row.complaints).map((c) => ({
        key: c.target,
        label: TARGET_LABEL[c.target],
        title: c.reason,
      })),
      judging: row.counts !== null && row.hasComplaint === null, // 분석은 끝났고 불만 판정은 아직
      duration: row.durationSec === null ? '' : fmtDuration(row.durationSec),
      // 이 통화로 접수된 주문 — 번호만 (주문 상태는 주문 화면에서, 11/07 사용자)
      order: d.orderSeq ? { seq: d.orderSeq, no: orderNo(d.orderSeq) } : null,
    }
  })

  return {
    q: params.q,
    asc,
    toggleSort: () => set({ d: asc ? 'desc' : 'asc' }),
    setQ: (q: string) => set({ q }),
    range: r,
    setRange: (v: Range) => set({ r: v }),
    state: s,
    setState: (v: StateFilter) => set({ s: v }),
    // 상태로 거를 때 받은 통화가 상한에 걸리면 알림 (기간을 줄이게)
    capped: !!s && (all.data?.length ?? 0) >= FETCH_ALL_MAX,
    rows,
    list: shown,
    // 줄에 마우스를 올리면 통화 기본 정보 · 대화를 미리 받음 — 상세가 바로 그려짐
    warm: (seq: number) => {
      void qc.prefetchQuery({ ...callQueries.detail(seq), staleTime: 30_000 })
      void qc.prefetchQuery({ ...callQueries.transcript(seq), staleTime: 30_000 })
    },
  }
}

type CallsVm = ReturnType<typeof useCalls>
export type CallsRow = CallsVm['rows'][number]
