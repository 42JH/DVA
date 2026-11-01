import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { FETCH_ALL_MAX, pageCount, pageSlice } from '@/shared/api/paging'
import { downloadCsv, toCsv } from '@/shared/lib/csv'
import { parseRange, todayYmd } from '@/shared/lib/dateRange'
import { fmtDuration, fmtListTime, fmtPhone, toDateTimeLocal } from '@/shared/lib/format'
import { matchKo, phoneDigits, suggest } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import type { Option, TagKind } from '@/shared/ui'
import { COMPLAINT_LABEL, NO_ANALYSIS, OUTCOME_LABEL, OUTCOME_TAG } from '@/features/call/labels'
import type { Outcome } from '@/features/call/api/callApi'
import {
  callListQueries,
  fetchAllCalls,
  type CallListQuery,
  type CallRow,
} from '@/features/call/api/callListApi'

/** 목록 한 줄 = 통화 + 화면용 글 (모르는 값은 '—', 분석 전은 '분석 전' 태그) */
export type CallListRow = CallRow & {
  time: string[] // 올해면 한 줄, 다른 해면 날짜 위 · 시각 아래
  name: string
  phone: string
  outcomeLabel: string
  outcomeTag: TagKind
  complaintView: { label: string; reason: string } | null
  duration: string
}
export type CallTab = 'all' | 'complaint'
type OutcomeFilter = Outcome | 'ALL'

const PAGE_SIZE = 20
const DEFAULTS = { tab: 'all', q: '', from: '', to: '', outcome: 'ALL' } // URL 쿼리 기본값 (모듈 상수 — useListParams 규칙)
const OUTCOME_ORDER: Outcome[] = ['SUCCESS', 'FAILED', 'HANDOFF', 'CANCELLED', 'INQUIRY']

/** 숫자만 쳤으면 그 숫자가 든 번호 추천 (새 결과가 오기 전 이전 줄이 남아 있어도 맞는 것만, 다 친 번호는 빼고). 숫자가 아니면 null */
function phoneSuggestions(rows: CallListRow[], digits: string): string[] | null {
  if (!digits) return null
  const hit = rows.filter((r) => r.callerNumber.includes(digits) && r.callerNumber !== digits)
  return [...new Set(hit.map((r) => r.phone))].slice(0, 5)
}

const toView = (c: CallRow): CallListRow => ({
  ...c,
  time: c.startedAt ? fmtListTime(c.startedAt) : ['—'],
  name: c.customerName ?? '—',
  phone: c.callerNumber ? fmtPhone(c.callerNumber) : '—',
  outcomeLabel: c.outcome ? OUTCOME_LABEL[c.outcome] : NO_ANALYSIS.label,
  outcomeTag: c.outcome ? OUTCOME_TAG[c.outcome] : NO_ANALYSIS.tag,
  complaintView: c.complaint
    ? { label: COMPLAINT_LABEL[c.complaint.type], reason: c.complaint.reason }
    : null,
  duration: c.durationSec === null ? '—' : fmtDuration(c.durationSec),
})

/** 04 통화 내역 훅 (와이어프레임 04_통화내역 · _불만 · _기간선택, 10/30)
 * 탭 [전체 | 불만 통화] · 검색(이름 · 전화번호) · 날짜 칸(기본 오늘) · 통화 결과 · 쪽은 URL에 (06 갔다가 뒤로가기 하면 그대로)
 * 줄을 누르면 그 통화의 06. CSV 내보내기 = 지금 조건의 전체 쪽 */
export function useCallList() {
  const navigate = useNavigate()
  const { params, page, set } = useListParams(DEFAULTS)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)

  const today = todayYmd()
  const range = parseRange(params.from, params.to, today) // 주소의 이상한 날짜(뒤집힘 · 미래 · 글자)는 오늘로
  const query: CallListQuery = {
    q: params.q,
    from: range?.from ?? today,
    to: range?.to ?? today,
    outcome: params.outcome as OutcomeFilter,
    complaintOnly: params.tab === 'complaint',
  }
  // 검색어가 없을 땐 서버가 쪽을 나눔. 검색어가 있으면 같은 조건(기간 · 탭 · 결과)의 통화 전체를 받아 09와 같은 규칙(초성 · 띄어쓰기 무시)으로
  // 앞에서 거르고 쪽을 나눔 — 서버 검색은 글자 그대로라 'ㅊㅇㅇ'이 안 됨 (11/02 사용자: 04도 09처럼). 전체는 5분 재사용
  // ponytail: fetchAll 2,000건 상한 — 긴 기간의 검색은 앞 2,000건 안에서만. 넘으면 서버 검색으로 돌릴 것
  const q = params.q.trim()
  const searching = q !== ''
  const list = useQuery({ ...callListQueries.list(query, page, PAGE_SIZE), enabled: !searching })
  const pool = useQuery({
    queryKey: [...callListQueries.all(), 'pool', { ...query, q: '' }],
    queryFn: ({ signal }) => fetchAllCalls({ ...query, q: '' }, signal),
    enabled: searching,
    staleTime: 5 * 60_000,
  })
  const poolRows = (pool.data ?? []).map(toView)
  const digits = phoneDigits(q) // 숫자만 쳤으면 번호로
  const hit = searching
    ? poolRows.filter((r) =>
        digits ? r.callerNumber.includes(digits) : matchKo(r.customerName ?? '', q),
      )
    : null
  const total = hit ? hit.length : (list.data?.totalCount ?? 0)
  const pages = pageCount(total, PAGE_SIZE)
  useEffect(() => {
    if ((hit ?? list.data) && page > pages) set({ page: pages }) // 주소의 쪽이 범위 밖이면 마지막 쪽으로
  }, [hit, list.data, page, pages, set])
  const rows = hit ? pageSlice(hit, page, PAGE_SIZE).rows : (list.data?.items ?? []).map(toView)

  const outcomeOptions: Option<OutcomeFilter>[] = [
    { value: 'ALL', label: '전체' },
    ...OUTCOME_ORDER.map((o) => ({ value: o, label: OUTCOME_LABEL[o] })),
  ]

  const exportCsv = async () => {
    if (total > FETCH_ALL_MAX) {
      // 목록은 100건씩 2,000건까지만 받을 수 있음 (CSV 엔드포인트 없음) — 조용히 잘린 파일을 주지 않게 막음 (11/02)
      setExportError(
        `통화가 ${FETCH_ALL_MAX.toLocaleString('ko-KR')}건을 넘어 내보낼 수 없습니다. 기간을 나눠 주세요.`,
      )
      return
    }
    setExporting(true)
    setExportError(null)
    try {
      const all = hit ?? (await fetchAllCalls(query)).map(toView) // 검색 중이면 화면과 같은 목록
      const csv = toCsv(
        ['통화 시작 시각', '고객', '발신번호', '통화 결과', '불만 유형', '불만 사유', '통화 시간'],
        all.map((c) => [
          // CSV는 늘 연도까지 ('2026-10-20 14:33') — 화면의 올해 연도 생략 규칙은 목록에만
          c.startedAt ? toDateTimeLocal(new Date(c.startedAt)).replace('T', ' ') : '—',
          c.name,
          c.phone,
          c.outcomeLabel,
          c.complaintView?.label ?? '',
          c.complaintView?.reason ?? '',
          c.duration,
        ]),
      )
      const span = query.from === query.to ? query.from : `${query.from}_${query.to}`
      downloadCsv(`통화내역_${span}${query.complaintOnly ? '_불만' : ''}.csv`, csv)
    } catch {
      setExportError('내보내지 못했습니다. 다시 시도해 주세요.')
    } finally {
      setExporting(false)
    }
  }

  return {
    tab: params.tab as CallTab,
    setTab: (t: CallTab) => set({ tab: t }),
    q: params.q,
    setQ: (v: string) => set({ q: v }),
    // 추천 = 같은 조건의 통화 전체에서 이름, 숫자만 쳤으면 번호
    suggestions:
      phoneSuggestions(poolRows, phoneDigits(params.q)) ??
      suggest(
        [...new Set(poolRows.flatMap((r) => (r.customerName ? [r.customerName] : [])))],
        params.q,
      ),
    range, // 날짜 칸 (null = 오늘)
    setRange: (r: { from: string; to: string }) =>
      // 오늘 하루를 고르면 기본값(빈 값)으로 → 주소가 깨끗하고 내일 열어도 '오늘'
      set(r.from === today && r.to === today ? { from: '', to: '' } : { from: r.from, to: r.to }),
    outcome: params.outcome as OutcomeFilter,
    outcomeOptions,
    setOutcome: (o: OutcomeFilter) => set({ outcome: o }),

    rows,
    count: total, // '통화 목록 131건'
    // 검색 밑천이 상한에 걸림 → 그 뒤 통화는 검색에 안 잡힘 (11/02)
    listNote:
      searching && poolRows.length >= FETCH_ALL_MAX
        ? `최근 ${FETCH_ALL_MAX.toLocaleString('ko-KR')}건 안에서만 검색됩니다. 기간을 줄여 주세요.`
        : null,
    isLoading: searching ? pool.isPending : list.isPending,
    listError: (searching ? pool.error : list.error)
      ? '불러오지 못했습니다. 다시 시도해 주세요.'
      : null,
    page: Math.min(page, pages),
    pages,
    goPage: (p: number) => set({ page: p }),

    openCall: (c: CallRow) => navigate(`/calls/${c.callSessionSeq}`),
    exportCsv,
    exporting,
    exportError,
    canExport: total > 0,
  }
}
