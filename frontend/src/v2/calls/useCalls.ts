// v2 통화 목록 — 쪽 번호(기준 시각 고정, useSnapshotList) + 기간 · 검색. GET /calls 그대로
// 기업 피드백: 통화 번호(#seq) 표기 · 상태(통화 중 · 분석 중 · 분석 실패 · 분석 완료)와 상담 결과(접수 · 조회 · 취소 · FAQ)를 다른 칸으로
import { fmtDuration, fmtPhone } from '@/shared/lib/format'
import { callKinds } from '@/v2/lib/kinds'
import { phoneDigits } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import { useDebounced } from '@/v2/lib/useDebounced'
import { useQueryClient } from '@tanstack/react-query'
import { toCallRow, type CallListItemDto } from '@/features/call/api/callDto'
import { callQueries } from '@/features/call/api/callApi'
import { COMPLAINT_LABEL } from '@/features/call/labels'
import { useSnapshotList } from '@/v2/lib/useSnapshotList'
import { rangeFrom, type Range } from '@/v2/lib/range'
import { dateTime } from '@/v2/lib/when'
import { callState, memberOf } from './callState'
import { orderNo } from '@/shared/order/labels'

const DEFAULTS = { q: '', r: '7d', at: '' } // at = 목록 기준 시각

/** 통화 상태 — 끝났는지(PBX 종료 시각)와 분석이 왔는지로 */

export function useCalls() {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  const r = params.r as Range
  const t = useDebounced(params.q.trim()) // 입력이 멈추면 한 번만 서버에
  const query = { q: (phoneDigits(t) || t).slice(0, 200) || undefined, from: rangeFrom(r) }

  const list = useSnapshotList<CallListItemDto>({
    key: 'calls',
    path: '/calls',
    query,
    at: (c) => c.startedAt,
    page,
    asOf: params.at,
    go: set,
  })

  const rows = list.items.map((d) => {
    const row = toCallRow(d)
    return {
      seq: d.callSessionSeq,
      state: callState(d),
      startedAt: dateTime(d.startedAt),
      name: row.customerName ?? '',
      isNew: row.isNew === true,
      company: memberOf(d),
      phone: row.callerNumber ? fmtPhone(row.callerNumber) : '',
      kinds: callKinds(row.counts),
      analyzed: row.counts !== null,
      // 불만 칩 — 이름만 (근거는 통화 상세, 칩에 올리면 근거가 뜸)
      complaints: row.complaints.map((c, i) => ({
        key: `${c.type}${i}`,
        label: COMPLAINT_LABEL[c.type],
        title: c.reason,
        tone: 'stop' as const,
      })),
      duration: row.durationSec === null ? '' : fmtDuration(row.durationSec),
      // 이 통화로 접수된 주문 — 번호만 (주문 상태는 주문 화면에서, 11/07 사용자)
      order: d.orderSeq ? { seq: d.orderSeq, no: orderNo(d.orderSeq) } : null,
    }
  })

  return {
    q: params.q,
    setQ: (q: string) => set({ q, at: '' }),
    range: r,
    setRange: (v: Range) => set({ r: v, at: '' }),
    rows,
    list,
    // 줄에 마우스를 올리면 통화 기본 정보 · 대화를 미리 받음 — 상세가 바로 그려짐
    warm: (seq: number) => {
      void qc.prefetchQuery({ ...callQueries.detail(seq), staleTime: 30_000 })
      void qc.prefetchQuery({ ...callQueries.transcript(seq), staleTime: 30_000 })
    },
  }
}

export type CallsVm = ReturnType<typeof useCalls>
export type CallRowV2 = CallsVm['rows'][number]
