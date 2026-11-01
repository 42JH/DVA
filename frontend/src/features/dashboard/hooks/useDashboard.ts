import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useSession } from '@/shared/auth/useSession'
import { rangeDays, todayYmd, type Ymd } from '@/shared/lib/dateRange'
import { fmtDay } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { COMPLAINT_LABEL, COMPLAINT_ORDER, OUTCOME_LABEL } from '@/features/dashboard/labels'
import {
  dashboardQueries,
  type GaugeOutcome,
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
const NO_STAT = '집계 API 없음' // 평균 통화 시간 · 되묻기: 명세 §10 — 성공하는 척 표시 금지

/** 02 대시보드 훅 (와이어프레임 02, 10/30) — [날짜별 | 페르소나별] · 날짜 칸(기본 오늘) · 고른 버전은 URL에
 * 날짜별: 통화 결과(게이지 = 성공 · 실패 · 이관) · 평균 두 칸(집계 API 없음 → '—') · AI 미답변 · 불만 내역. 다른 기간과 비교 없음 (10/30)
 * 페르소나별(최고 관리자만): 버전별 기록(최근 3개) + 고른 버전의 AI 미답변 · 불만 내역
 * 숫자는 전부 목록 total_count (명세 §10: 통계 API 없음) */
export function useDashboard() {
  const navigate = useNavigate()
  const { isSystemAdmin } = useSession()
  const { params, set } = useListParams(DEFAULTS)
  const tabs = isSystemAdmin ? TABS : TABS.filter((t) => t.key === 'date')
  const tab: DashboardTab = params.tab === 'persona' && isSystemAdmin ? 'persona' : 'date'
  const today = todayYmd()
  const range = params.from ? { from: params.from, to: params.to || params.from } : null
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
    from === to ? (from === today ? '오늘' : dayOnly(from)) : `${rangeDays(from, to)}일간`

  /** 아래 두 카드 (날짜별 · 페르소나별 같은 모양) */
  const bottom = (s: Stats, scope: string, multiDay: boolean, f: Ymd, t: Ymd) => ({
    unanswered: {
      sub: `${scope} ${num(s.unanswered.count)}개`,
      timeHeader: multiDay ? '날짜' : '통화 시각',
      rows: s.unanswered.recent.map((u, i) => ({
        key: `${u.at}-${i}`,
        question: u.question,
        time: multiDay ? dayOnly(u.at) : hm(u.at),
      })),
      onMore: () => navigate('/faqs/unanswered'),
    },
    complaints: {
      sub:
        `${scope} 불만 통화 ${num(s.complaintCalls)}건` +
        (s.complaintCalls ? ` · 전체 통화의 ${pct(s.complaintCalls, s.total, 1)}` : ''),
      total: s.complaintCalls,
      rows: COMPLAINT_ORDER.map((k) => ({
        key: k,
        label: COMPLAINT_LABEL[k],
        count: s.complaints[k],
      })),
      onMore: () => toCalls({ tab: 'complaint' }, f, t),
    },
  })

  const s = stats.data
  const date = s
    ? (() => {
        const gauge: Outcome[] = ['SUCCESS', 'FAILED', 'HANDOFF']
        const base = gauge.reduce((a, k) => a + s.counts[k], 0) // 게이지 = 성공 · 실패 · 이관 (주문 취소 · 문의 뺌)
        return {
          scope: `${scopeOfRange} 받은 AI 통화`,
          total: num(s.total), // 결과 필터 없는 전체 (분석 전 통화 포함) = 04 '전체'
          rate: pct(s.counts.SUCCESS, base),
          base: `${num(base)}건 중`,
          gauge: gauge.map((k) => ({ key: k, value: s.counts[k] })),
          rows: gauge.map((k) => ({
            key: k,
            label: OUTCOME_LABEL[k],
            count: num(s.counts[k]),
            pct: pct(s.counts[k], base),
            onClick: () => toCalls({ outcome: k }, from, to),
          })),
          // 게이지 밖 통화 (선 아래 한 줄)
          others: (['CANCELLED', 'INQUIRY'] as const).map((k) => ({
            key: k,
            label: OUTCOME_LABEL[k],
            count: num(s.counts[k]),
            onClick: () => toCalls({ outcome: k }, from, to),
          })),
          // 평균 두 칸: 통계 API가 없어 값 대신 안내 (BE 요청 B3)
          avgs: [
            { key: 'time', icon: 'clock' as const, label: '평균 통화 시간', note: NO_STAT },
            { key: 'repeat', icon: 'repeat' as const, label: '평균 되묻기', note: NO_STAT },
          ],
          ...bottom(s, scopeOfRange, from !== to, from, to),
        }
      })()
    : null

  const versionRow = (v: Version) => {
    const n = v.counts.SUCCESS + v.counts.FAILED + v.counts.HANDOFF // '통화' = 게이지와 같은 세 결과
    const cell = (k: GaugeOutcome) => ({
      pct: pct(v.counts[k], n, 1),
      count: `${num(v.counts[k])}건`,
    })
    return {
      id: v.id,
      name: `${v.personaName} v${v.version}`,
      active: v.active,
      period: v.to
        ? `${dayOnly(`${v.from}T00:00`)} ~ ${dayOnly(`${v.to}T00:00`)}`
        : `${dayOnly(`${v.from}T00:00`)} ~`,
      calls: `${num(n)}건`,
      success: cell('SUCCESS'),
      failed: cell('FAILED'),
      handoff: cell('HANDOFF'),
      avgTime: '—', // 집계 API 없음
      avgRepeat: '—',
      selected: v.id === selected?.id,
      onSelect: () => set({ version: v.id }),
    }
  }

  const vs = versionStats.data
  const persona =
    versions.data && selected
      ? {
          // 오른쪽 위 = 아래 두 카드의 범위 = 고른 버전의 운영 기간 (적용 중이면 오늘까지)
          header: `${selected.personaName} v${selected.version} · ${fmtDay(`${selected.from}T00:00`)} ~ ${fmtDay(`${selected.to ?? today}T00:00`)}`,
          rows: versions.data.map(versionRow),
          cards: vs
            ? bottom(vs, `v${selected.version}`, true, selected.from, selected.to ?? today)
            : null,
        }
      : versions.data && versions.data.length === 0
        ? { header: '', rows: [], cards: null } // 적용된 버전이 아직 없음
        : null

  return {
    tabs,
    tab,
    setTab: (t: DashboardTab) => set({ tab: t }),
    range,
    setRange: (r: { from: string; to: string }) =>
      set(r.from === today && r.to === today ? { from: '', to: '' } : { from: r.from, to: r.to }),
    isLoading: tab === 'date' ? stats.isPending : versions.isPending,
    error: (tab === 'date' ? stats.error : (versions.error ?? versionStats.error))
      ? '불러오지 못했습니다. 다시 시도해 주세요.'
      : null,
    date,
    persona,
  }
}
