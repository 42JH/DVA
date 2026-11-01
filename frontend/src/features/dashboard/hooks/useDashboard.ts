import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import {
  fmtRange,
  fmtYmds,
  parseRange,
  rangeDays,
  todayYmd,
  type Ymd,
} from '@/shared/lib/dateRange'
import { fmtDay, fmtDayRange, fmtDuration, fmtPctSplit, fmtShortDate } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { COMPLAINT_LABEL, COMPLAINT_ORDER, OUTCOME_LABEL } from '@/features/dashboard/labels'
import {
  dashboardQueries,
  GAUGE,
  type Outcome,
  type Stats,
  type Version,
} from '@/features/dashboard/api/dashboardApi'

export type DashboardTab = 'date' | 'persona'
const TABS: { key: DashboardTab; label: string }[] = [
  { key: 'date', label: '날짜별' },
  { key: 'persona', label: '페르소나별' }, // 버전 API가 최고 관리자 전용 (명세 §8) → 최고 관리자에게만
]

// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). from · to가 비면 오늘, version이 비면 적용 중인 버전
const DEFAULTS = { tab: 'date', from: '', to: '', version: '' }

const two = (n: number) => String(n).padStart(2, '0')
const pct = (n: number, of: number, digits = 0) =>
  of ? `${((n / of) * 100).toFixed(digits)}%` : '—'
const num = (n: number) => n.toLocaleString('ko-KR')
const hm = (iso: string) => {
  const d = new Date(iso)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
/** 여러 날 목록 = 날짜만 (10/29: 'MM.DD HH:MM'이면 질문이 잘림). 다른 해면 연도 (10/30 연도 규칙) */
const dayOnly = (iso: string) => fmtDay(iso).replace(/ \(.\)$/, '')
const NO_STAT = '되묻기 미측정' // 평균 되묻기: AI가 repeatQuestionCount 를 안 준 기간 (성공하는 척 표시 금지, 명세 §10)
/** 초 → 카드의 큰 값 [['3', '분'], ['40', '초']] */
const clockParts = (sec: number): [string, string][] => {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600) // 한 시간 넘으면 '1시간 5분 03초' (11/02)
  return [
    ...(h ? ([[String(h), '시간']] as [string, string][]) : []),
    [String(Math.floor(s / 60) % 60), '분'],
    [two(s % 60), '초'],
  ]
}
const durationText = (sec: number | null) => (sec === null ? '—' : fmtDuration(Math.round(sec)))

/** 02 대시보드 훅 (와이어프레임 02, 10/30) — [날짜별 | 페르소나별] · 날짜 칸(기본 오늘) · 고른 버전은 URL에
 * 날짜별: 통화 결과(게이지 = 접수 시도 = 성공 · 실패 · 이관, 줄 = 다섯 결과 건수) · 평균 두 칸 · AI 미답변 · 불만 내역. 다른 기간과 비교 없음 (10/30)
 * 페르소나별(최고 관리자만): 버전별 기록(최근 3개) + 고른 버전의 AI 미답변 · 불만 내역
 * 숫자는 전부 목록 total_count (명세 §10: 통계 API 없음) */
export function useDashboard() {
  const navigate = useNavigate()
  const { isSystemAdmin } = useSession()
  const { params, set } = useListParams(DEFAULTS)
  const tabs = isSystemAdmin ? TABS : TABS.filter((t) => t.key === 'date')
  const tab: DashboardTab = params.tab === 'persona' && isSystemAdmin ? 'persona' : 'date'
  const today = todayYmd()
  const range = parseRange(params.from, params.to, today) // 주소의 이상한 날짜(뒤집힘 · 미래 · 글자)는 오늘로
  const from = range?.from ?? today
  const to = range?.to ?? today

  const stats = useQuery({ ...dashboardQueries.stats(from, to), enabled: tab === 'date' })
  const versions = useQuery({ ...dashboardQueries.versions(), enabled: tab === 'persona' })
  const selected =
    versions.data?.find((v) => v.id === params.version) ?? versions.data?.find((v) => v.active)
  const versionStats = useQuery({
    ...dashboardQueries.versionStats(selected?.id ?? ''),
    enabled: tab === 'persona' && !!selected,
  })

  // 04 통화 내역으로 — 같은 기간 · 그 결과 (오늘 하루면 04 기본값이라 날짜를 안 붙임)
  const toCalls = (extra: Record<string, string>, f: Ymd, t: Ymd) => {
    const q = new URLSearchParams(extra)
    if (!(f === today && t === today)) {
      q.set('from', f)
      q.set('to', t)
    }
    navigate(`/calls${q.toString() ? `?${q}` : ''}`)
  }

  const scopeOfRange =
    from === to ? (from === today ? '오늘' : fmtShortDate(from)) : `${rangeDays(from, to)}일간`

  /** 아래 두 카드 (날짜별 · 페르소나별 같은 모양). more = '… 보기 ›'가 넘길 기간
   * 페르소나별은 null → 링크 없음 (D2: 04 · 09에 버전 필터가 없어 카드 숫자와 목록이 안 맞음) */
  const bottom = (s: Stats, scope: string, multiDay: boolean, more: { f: Ymd; t: Ymd } | null) => ({
    unanswered: {
      sub: `${scope} ${num(s.unanswered.count)}개`,
      timeHeader: multiDay ? '날짜' : '통화 시각',
      rows: s.unanswered.recent.map((u, i) => ({
        key: `${u.at}-${i}`,
        question: u.question,
        time: multiDay ? dayOnly(u.at) : hm(u.at),
      })),
      onMore: more ? () => navigate('/faqs/unanswered') : undefined,
    },
    complaints: {
      sub:
        `${scope} 불만 통화 ${num(s.complaintCalls)}건` +
        (s.complaintCalls ? ` · 전체 통화의 ${pct(s.complaintCalls, s.total, 1)}` : '') +
        (s.avgSampled ? ' · 유형별은 최근 2,000건 기준' : ''),
      total: s.complaintCalls,
      rows: COMPLAINT_ORDER.map((k) => ({
        key: k,
        label: COMPLAINT_LABEL[k],
        count: s.complaints[k],
      })),
      onMore: more ? () => toCalls({ tab: 'complaint' }, more.f, more.t) : undefined,
    },
  })

  const s = stats.data
  const date = s
    ? (() => {
        // 줄 = 분석된 통화 전부 다섯 결과의 건수 (11/01 사용자: 문의 · 취소도 통화니 결과 집계에 들어가야)
        // 링 · 성공률 = 접수 시도(성공 · 실패 · 이관)만 — 문의 · 취소는 주문을 시도하지 않은 통화라 분모에 안 넣음 (11/01 결정, 11/02: 7/18 = 39%로 오해)
        const all: Outcome[] = ['SUCCESS', 'FAILED', 'INQUIRY', 'HANDOFF', 'CANCELLED'] // 줄 순서 (11/01 사용자). 색은 ResultCard COLOR
        const analysed = all.reduce((a, k) => a + s.counts[k], 0)
        const tried = GAUGE.reduce((a, k) => a + s.counts[k], 0)
        return {
          scope: `${scopeOfRange} 받은 AI 통화`,
          total: num(s.total), // 결과 필터 없는 전체 (분석 전 통화 포함) = 04 '전체'
          unanalysed: s.total > analysed ? `분석 전 ${num(s.total - analysed)}건` : null,
          rate: pct(s.counts.SUCCESS, tried), // 페르소나별 표의 성공 비율과 같은 분모
          base: `접수 시도 ${num(tried)}건 중 ${num(s.counts.SUCCESS)}건 성공`,
          gauge: GAUGE.map((k) => ({ key: k, value: s.counts[k] })),
          rows: all.map((k) => ({
            key: k,
            label: OUTCOME_LABEL[k],
            count: num(s.counts[k]),
            onClick: () => toCalls({ outcome: k }, from, to),
          })),
          // 평균 두 칸: 통계 API가 없어 값 대신 안내 (BE 요청 B3)
          // 평균 통화 시간은 목록으로 화면에서 냄 (11/01 사용자) · 되묻기는 줄 데이터가 없어 아직 '—'
          avgs: [
            {
              key: 'time',
              icon: 'clock' as const,
              label: '평균 통화 시간',
              value: s.avgDurationSec === null ? undefined : clockParts(s.avgDurationSec),
              split: [
                ['접수 성공', durationText(s.avgBy.SUCCESS)],
                ['접수 실패', durationText(s.avgBy.FAILED)],
              ] as [string, string][],
              note: s.avgSampled ? '최근 2,000건 기준' : undefined,
            },
            {
              key: 'repeat',
              icon: 'repeat' as const,
              label: '평균 되묻기',
              // analysis.repeatQuestionCount 평균 (11/01). AI가 아직 안 재면 '—' + 안내
              value:
                s.avgRepeat === null
                  ? undefined
                  : ([[s.avgRepeat.toFixed(1), '회']] as [string, string][]),
              note: s.avgRepeat === null ? NO_STAT : undefined,
            },
          ],
          ...bottom(s, scopeOfRange, from !== to, { f: from, t: to }),
        }
      })()
    : null

  const versionRow = (v: Version) => {
    const n = v.counts.SUCCESS + v.counts.FAILED + v.counts.HANDOFF // '통화' = 게이지와 같은 세 결과
    const pcts = fmtPctSplit(
      GAUGE.map((k) => v.counts[k]),
      1,
    )
    const cell = (i: number) => ({ pct: pcts[i], count: `${num(v.counts[GAUGE[i]])}건` })
    return {
      id: v.id,
      name: `${v.personaName} v${v.version}`,
      active: v.active,
      // 운영 기간 (10/30 연도 규칙: 한쪽이라도 다른 해면 양쪽 다 연도). 적용 중이면 '~'만
      period: v.to ? fmtRange(v.from, v.to, today) : `${fmtYmds([v.from], today)[0]} ~`,
      calls: `${num(n)}건`,
      success: cell(0),
      failed: cell(1),
      handoff: cell(2),
      // 날짜별과 같은 방식 — 그 버전의 통화 목록으로 화면에서 평균 (11/02 사용자)
      avgTime: durationText(v.avgDurationSec),
      avgRepeat: v.avgRepeat === null ? '—' : `${v.avgRepeat.toFixed(1)}회`,
      selected: v.id === selected?.id,
      onSelect: () => set({ version: v.id }),
    }
  }

  const vs = versionStats.data
  const persona =
    versions.data && selected
      ? {
          // 오른쪽 위 = 아래 두 카드의 범위 = 고른 버전의 운영 기간 (적용 중이면 오늘까지)
          header: `${selected.personaName} v${selected.version} · ${fmtDayRange(`${selected.from}T00:00`, `${selected.to ?? today}T00:00`)}`,
          rows: versions.data.map(versionRow),
          note: versions.data.some((v) => v.avgSampled) ? '평균은 버전별 최근 2,000건 기준' : null,
          cards: vs ? bottom(vs, `v${selected.version}`, true, null) : null,
        }
      : versions.data && versions.data.length === 0
        ? { header: '', rows: [], note: null, cards: null } // 적용된 버전이 아직 없음
        : null

  return {
    tabs,
    tab,
    setTab: (t: DashboardTab) => set({ tab: t }),
    range,
    setRange: (r: { from: string; to: string }) =>
      set(r.from === today && r.to === today ? { from: '', to: '' } : { from: r.from, to: r.to }),
    isLoading: tab === 'date' ? stats.isPending : versions.isPending,
    // 날짜 · 버전을 바꿔 다시 받는 동안 (이전 카드가 남아 있음 → 흐리게. 큰 기간은 몇 초 걸림, 11/02)
    isFetching:
      tab === 'date'
        ? stats.isFetching && !stats.isPending
        : versionStats.isFetching && !versionStats.isPending,
    error: (tab === 'date' ? stats.error : (versions.error ?? versionStats.error))
      ? '불러오지 못했습니다. 다시 시도해 주세요.'
      : null,
    date,
    persona,
  }
}
