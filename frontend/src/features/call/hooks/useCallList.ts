import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { pageCount } from '@/shared/api/paging'
import { downloadCsv, toCsv } from '@/shared/lib/csv'
import { todayYmd } from '@/shared/lib/dateRange'
import { fmtDuration, fmtListTime, fmtPhone } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import type { Option, TagKind } from '@/shared/ui'
import { OUTCOME_LABEL, OUTCOME_TAG } from '@/features/call/labels'
import type { Outcome } from '@/features/call/api/callApi'
import {
  callListQueries,
  fetchAllCalls,
  type CallListQuery,
  type CallRow,
} from '@/features/call/api/callListApi'

/** 목록 한 줄 = 통화 + 화면용 글 */
export type CallListRow = CallRow & {
  time: string[] // 올해면 한 줄, 다른 해면 날짜 · 시각 두 줄
  phone: string
  outcomeLabel: string
  outcomeTag: TagKind
  duration: string
}

export type CallTab = 'all' | 'complaint'
type OutcomeFilter = Outcome | 'ALL'

const PAGE_SIZE = 20
// URL 쿼리 기본값 (모듈 상수 — useListParams 규칙). from · to가 비면 오늘
const DEFAULTS = { tab: 'all', q: '', from: '', to: '', outcome: 'ALL' }
// 통화 결과 드롭다운 = 전체 + 와이어프레임 04 순서 (6개)
const OUTCOME_ORDER: Outcome[] = ['SUCCESS', 'FAILED', 'HANDOFF', 'CANCELLED', 'INQUIRY']

/** 04 통화 내역 훅 (와이어프레임 04_통화내역 · _불만 · _기간선택, 10/30)
 * 탭 [전체 | 불만 통화] · 검색(이름 · 전화번호) · 날짜 칸(기본 오늘) · 통화 결과 · 쪽은 URL에 (06 갔다가 뒤로가기 하면 그대로)
 * 줄을 누르면 그 통화의 06. CSV 내보내기 = 지금 조건의 전체 쪽 */
export function useCallList() {
  const navigate = useNavigate()
  const { params, page, set } = useListParams(DEFAULTS)
  const [exporting, setExporting] = useState(false)

  const today = todayYmd()
  const range = params.from ? { from: params.from, to: params.to || params.from } : null
  const query: CallListQuery = {
    q: params.q,
    from: range?.from ?? today,
    to: range?.to ?? today,
    outcome: params.outcome as OutcomeFilter,
    complaintOnly: params.tab === 'complaint',
  }
  const list = useQuery(callListQueries.list(query, page, PAGE_SIZE))
  const total = list.data?.totalCount ?? 0

  const rows: CallListRow[] = (list.data?.items ?? []).map((c) => ({
    ...c,
    time: fmtListTime(c.startedAt),
    phone: fmtPhone(c.callerNumber),
    outcomeLabel: OUTCOME_LABEL[c.outcome],
    outcomeTag: OUTCOME_TAG[c.outcome],
    duration: fmtDuration(c.durationSec),
  }))

  const outcomeOptions: Option<OutcomeFilter>[] = [
    { value: 'ALL', label: '전체' },
    ...OUTCOME_ORDER.map((o) => ({ value: o, label: OUTCOME_LABEL[o] })),
  ]

  const exportCsv = async () => {
    setExporting(true)
    try {
      const all = await fetchAllCalls(query)
      const csv = toCsv(
        ['통화 시작 시각', '고객', '발신번호', '통화 결과', '불만 유형', '불만 사유', '통화 시간'],
        all.map((c) => [
          fmtListTime(c.startedAt).join(' '),
          c.customerName,
          fmtPhone(c.callerNumber),
          OUTCOME_LABEL[c.outcome],
          c.complaint?.kind ?? '',
          c.complaint?.reason ?? '',
          fmtDuration(c.durationSec),
        ]),
      )
      const span = query.from === query.to ? query.from : `${query.from}_${query.to}`
      downloadCsv(`통화내역_${span}${query.complaintOnly ? '_불만' : ''}.csv`, csv)
    } finally {
      setExporting(false)
    }
  }

  return {
    tab: params.tab as CallTab,
    setTab: (t: CallTab) => set({ tab: t }),
    q: params.q,
    setQ: (v: string) => set({ q: v }),
    range, // 날짜 칸 (null = 오늘)
    setRange: (r: { from: string; to: string }) =>
      // 오늘 하루를 고르면 기본값(빈 값)으로 → 주소가 깨끗하고 내일 열어도 '오늘'
      set(r.from === today && r.to === today ? { from: '', to: '' } : { from: r.from, to: r.to }),
    outcome: params.outcome as OutcomeFilter,
    outcomeOptions,
    setOutcome: (o: OutcomeFilter) => set({ outcome: o }),

    rows,
    count: total, // '통화 목록 131건'
    isLoading: list.isPending,
    listError: list.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,
    page,
    pages: pageCount(total, PAGE_SIZE),
    goPage: (p: number) => set({ page: p }),

    openCall: (c: CallRow) => navigate(`/calls/${c.callSessionSeq}`),
    exportCsv,
    exporting,
    canExport: total > 0,
  }
}
