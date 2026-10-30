import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { rangeDays, todayYmd, type Ymd } from '@/shared/lib/dateRange'
import { fmtDay, fmtDuration } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { COMPLAINT_LABEL, COMPLAINT_ORDER, OUTCOME_LABEL } from '@/features/dashboard/labels'
import {
  dashboardQueries,
  type Outcome,
  type Stats,
  type Version,
} from '@/features/dashboard/api/dashboardApi'

export type DashboardTab = 'date' | 'persona'

// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). from · to가 비면 오늘, version이 비면 적용 중인 버전
const DEFAULTS = { tab: 'date', from: '', to: '', version: '' }

const two = (n: number) => String(n).padStart(2, '0')
const pct = (n: number, of: number, digits = 0) =>
  of ? `${((n / of) * 100).toFixed(digits)}%` : '—'
const num = (n: number) => n.toLocaleString('ko-KR')
/** 초 → [['2', '분'], ['51', '초']] (큰 숫자 + 작은 단위) */
const minSec = (s: number): [string, string][] => [
  [String(Math.floor(s / 60)), '분'],
  [two(s % 60), '초'],
]
const hm = (iso: string) => {
  const d = new Date(iso)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
/** 여러 날 목록 = 날짜만 (10/29: 'MM.DD HH:MM'이면 질문이 잘림). 다른 해면 연도 (10/30 연도 규칙) */
const dayOnly = (iso: string) => fmtDay(iso).replace(/ \(.\)$/, '')

/** 02 대시보드 훅 (와이어프레임 02, 10/30) — [날짜별 | 페르소나별] · 날짜 칸(기본 오늘) · 고른 버전은 URL에
 * 날짜별: 통화 결과(게이지 = 성공 · 실패 · 이관) · 평균 두 칸 · AI 미답변 · 불만 내역. 다른 기간과 비교 없음 (10/30)
 * 페르소나별: 버전별 기록(최근 3개) + 고른 버전의 AI 미답변 · 불만 내역 */
export function useDashboard() {
  const navigate = useNavigate()
  const { params, set } = useListParams(DEFAULTS)
  const tab = params.tab as DashboardTab
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
  const bottom = (s: Stats, scope: string, multiDay: boolean, f: Ymd, t: Ymd) => {
    const total = Object.values(s.counts).reduce((a, b) => a + b, 0)
    const complaintTotal = COMPLAINT_ORDER.reduce((a, k) => a + s.complaints[k], 0)
    return {
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
          `${scope} 불만 통화 ${num(complaintTotal)}건` +
          (complaintTotal ? ` · 전체 통화의 ${pct(complaintTotal, total, 1)}` : ''),
        total: complaintTotal,
        rows: COMPLAINT_ORDER.map((k) => ({
          key: k,
          label: COMPLAINT_LABEL[k],
          count: s.complaints[k],
        })),
        onMore: () => toCalls({ tab: 'complaint' }, f, t),
      },
    }
  }

  const s = stats.data
  const date = s
    ? (() => {
        const gauge: Outcome[] = ['SUCCESS', 'FAILED', 'HANDOFF']
        const base = gauge.reduce((a, k) => a + s.counts[k], 0) // 게이지 = 성공 · 실패 · 이관 (주문 취소 · 문의 뺌)
        const total = Object.values(s.counts).reduce((a, b) => a + b, 0)
        return {
          scope: `${scopeOfRange} 받은 AI 통화`,
          total: num(total),
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
          avgs: [
            {
              key: 'time',
              icon: 'clock' as const,
              label: '평균 통화 시간',
              value: minSec(s.avgCallSec),
              split: [
                ['접수 성공', fmtDuration(s.avgCallSecBy.success)],
                ['접수 실패', fmtDuration(s.avgCallSecBy.failed)],
              ] as [string, string][],
            },
            {
              key: 'repeat',
              icon: 'repeat' as const,
              label: '평균 되묻기',
              value: [[s.avgRepeat.toFixed(1), '회']] as [string, string][],
              split: [
                ['접수 성공', `${s.avgRepeatBy.success.toFixed(1)}회`],
                ['접수 실패', `${s.avgRepeatBy.failed.toFixed(1)}회`],
              ] as [string, string][],
            },
          ],
          ...bottom(s, scopeOfRange, from !== to, from, to),
        }
      })()
    : null

  const versionRow = (v: Version) => {
    const n = v.counts.SUCCESS + v.counts.FAILED + v.counts.HANDOFF // '통화' = 게이지와 같은 세 결과
    const cell = (k: Outcome) => ({ pct: pct(v.counts[k], n, 1), count: `${num(v.counts[k])}건` })
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
      avgTime: fmtDuration(v.avgCallSec),
      avgRepeat: `${v.avgRepeat.toFixed(1)}회`,
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
      : null

  return {
    tab,
    setTab: (t: DashboardTab) => set({ tab: t }),
    range,
    setRange: (r: { from: string; to: string }) =>
      set(r.from === today && r.to === today ? { from: '', to: '' } : { from: r.from, to: r.to }),
    isLoading: tab === 'date' ? stats.isPending : versions.isPending || versionStats.isPending,
    error: (tab === 'date' ? stats.error : (versions.error ?? versionStats.error))
      ? '불러오지 못했습니다. 다시 시도해 주세요.'
      : null,
    date,
    persona,
  }
}
