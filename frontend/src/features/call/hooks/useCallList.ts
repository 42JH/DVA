import { todayYmd, type Ymd } from '@/shared/lib/dateRange'
import { fmtDuration, fmtPhone, fmtTime } from '@/shared/lib/format'
import { useDayFeed } from '@/shared/lib/useDayFeed'
import { useListParams } from '@/shared/lib/useListParams'
import { KINDS, KIND_LABEL, kindChips } from '@/shared/lib/callKind'
import { COMPLAINT_LABEL } from '@/features/call/labels'
import { matchCall, type CallFilter, type CallKind } from '@/features/call/api/callDto'
import {
  fetchCallDay,
  prevCallDay,
  nextCallDay,
  type CallRow,
} from '@/features/call/api/callListApi'

export type { CallKind } from '@/features/call/api/callDto'

export { KINDS, kindChips } from '@/shared/lib/callKind'
export const DUR_MAX = 20 // 통화 시간 슬라이더 끝(분) — 끝까지 두면 위 제한 없음

/** 필터 창 값 (분 단위). max === DUR_MAX = 위 제한 없음 */
export interface CallFilterForm {
  newOnly: boolean
  kinds: CallKind[]
  min: number
  max: number
}
export const NO_FILTER: CallFilterForm = { newOnly: false, kinds: [], min: 0, max: DUR_MAX }

/** 목록 한 줄 = 통화 + 화면용 글 (Figma '통화' 11/04) */
export type CallListRow = CallRow & {
  day: Ymd // 받은 날 (머리 날짜 · 스크롤 위치)
  time: string // '오후 3:02' (날은 머리줄 · 표 왼쪽 날짜)
  name: string
  phone: string // 마스킹 안 함 (11/04 사용자)
  kinds: { kind: CallKind; label: string }[] // 한 것만 — 두 번 이상이면 '접수 3'
  complaint: { label: string; reasons: string[] } | null // 첫 불만 유형 + 근거(말풍선)
  duration: string
}

// URL 쿼리 기본값 (useListParams 규칙: 모듈 상수) — 06 갔다가 뒤로가기 하면 날짜 · 조건 그대로
// date '' = 오늘 · at = 그 통화가 맨 위에 오게(상담가를 골라 옮겨 왔을 때) · new '1' = 신규만 · kinds 'accept,faq' · dur '3-10'(분, 끝이 비면 제한 없음)
const DEFAULTS = { date: '', at: '', q: '', new: '', kinds: '', dur: '' }

const toView = (r: CallRow, day: Ymd): CallListRow => ({
  ...r,
  day,
  time: r.startedAt ? fmtTime(r.startedAt) : '—',
  name: r.customerName ?? '—',
  company: r.company ?? '',
  phone: r.callerNumber ? fmtPhone(r.callerNumber) : '—',
  kinds: kindChips(r.counts),
  complaint: r.complaints.length
    ? { label: COMPLAINT_LABEL[r.complaints[0].type], reasons: r.complaints.map((c) => c.reason) }
    : null,
  duration: r.durationSec === null ? '' : fmtDuration(r.durationSec),
})

function parseForm(p: typeof DEFAULTS): CallFilterForm {
  const [lo, hi] = p.dur.split('-')
  const min = Math.min(DUR_MAX, Math.max(0, Math.floor(Number(lo)) || 0))
  const max = hi ? Math.min(DUR_MAX, Math.max(min, Math.floor(Number(hi)) || DUR_MAX)) : DUR_MAX
  return {
    newOnly: p.new === '1',
    kinds: KINDS.filter((k) => p.kinds.split(',').includes(k)),
    min,
    max,
  }
}
const toFilter = (f: CallFilterForm): CallFilter => ({
  newOnly: f.newOnly,
  kinds: f.kinds,
  minSec: f.min * 60,
  maxSec: f.max >= DUR_MAX ? null : f.max * 60,
})

/** 04 통화 내역 훅 (Figma '통화' 11/04) — 고른 날짜(기본 오늘)부터 하루씩 무한 스크롤, 오늘은 5초마다 새로
 *  거르기: 검색(이름 · 전화번호, 서버) · 머리줄 '상담 유형 ⌄'(하나) · 필터 창(신규 · 상담 유형 · 통화 시간, 화면). 줄을 누르면 그 통화의 06 */
export function useCallList() {
  const { params, set } = useListParams(DEFAULTS)
  const today = todayYmd()
  const anchor =
    /^\d{4}-\d{2}-\d{2}$/.test(params.date) && params.date < today ? params.date : today
  const q = params.q.trim()
  const form = parseForm(params)
  const filter = toFilter(form)

  const feed = useDayFeed({
    key: ['calls', 'list'],
    filter: q,
    anchor,
    fetchDay: (day, signal) => fetchCallDay(day, q, signal),
    prevDay: (day, signal) => prevCallDay(day, q, signal),
    nextDay: (day, signal) => nextCallDay(day, q, signal),
    pending: (r) => r.counts === null, // 분석 전 — 늦게 오는 분석이 보이게
  })
  const days = feed.days.map(({ day, rows }) => ({
    day,
    rows: rows.filter((r) => matchCall(r, filter)).map((r) => toView(r, day)),
  }))
  const isFiltered = form.newOnly || form.kinds.length > 0 || form.min > 0 || form.max < DUR_MAX

  return {
    anchor,
    feed: { ...feed, days },
    at: Number(params.at) || null, // 처음 그릴 때 이 통화를 맨 위로

    setDate: (d: Ymd) => set({ date: d >= today ? '' : d, at: '' }),

    q: params.q,
    // 검색하면 오늘부터 (최근 통화가 위) — 지난 날짜에 머물러 있으면 새 결과가 안 보임. 같은 값이면 그대로
    setQ: (v: string) => {
      if (v.trim() !== params.q.trim()) set({ q: v.trim(), date: '', at: '' })
    },

    form,
    isFiltered,
    // 머리줄 '상담 유형 ⌄' (11/06 시안) — 하나만 고름(필터 창에서 여럿 고른 상태면 '전체'로 보임). 신규 · 통화 시간 조건은 그대로
    kind: (form.kinds.length === 1 ? form.kinds[0] : 'ALL') as CallKind | 'ALL',
    kindOptions: [
      { value: 'ALL' as const, label: '전체' },
      ...KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
    ],
    setKind: (k: CallKind | 'ALL') => set({ at: '', kinds: k === 'ALL' ? '' : k }),
    applyForm: (f: CallFilterForm) =>
      set({
        at: '',
        new: f.newOnly ? '1' : '',
        kinds: f.kinds.join(','),
        dur: f.min === 0 && f.max === DUR_MAX ? '' : `${f.min}-${f.max === DUR_MAX ? '' : f.max}`,
      }),
  }
}
