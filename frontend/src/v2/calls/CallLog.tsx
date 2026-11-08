// 통화 기록 (대화 + AI 동작) — 주문의 통화 창 · 미답변의 통화 창이 같이 씀. 스크롤은 감싸는 쪽이
// focusSec를 주면 그 시각 직전의 고객 말(질문은 고객이 함)을 노랗게 표시하고 가운데로 스크롤
import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { callQueries } from '@/features/call/api/callApi'
import type { UtteranceDto } from '@/features/call/api/callDto'
import { refineAction } from '@/features/call/actionText'
import { fmtClock } from '@/shared/lib/format'
import { AiSteps, Talk, type AiStep } from './AiSteps'

export function CallLog({
  seq,
  showAi,
  focusSec = null,
}: {
  seq: number
  showAi: boolean
  focusSec?: number | null
}) {
  const q = useQuery({ ...callQueries.transcript(seq), staleTime: 30_000 })
  const acts = useQuery({ ...callQueries.actions(seq), staleTime: 30_000 })
  const box = useRef<HTMLDivElement>(null)

  // 말과 AI 동작을 통화 안 시각 순으로 (같은 시각이면 말 먼저, 시각 모르면 맨 끝)
  const at = (sec: number | null) => sec ?? Infinity
  const timeline = [
    ...(q.data ?? []).map((l) => ({ t: at(l.offsetSeconds), n: 0, line: l, act: null })),
    ...(showAi ? (acts.data ?? []) : []).map((a) => ({
      t: at(a.offsetSeconds),
      n: 1,
      line: null,
      act: a,
    })),
  ].sort((a, b) => a.t - b.t || a.n - b.n)
  // 연달아 나온 AI 동작은 한 묶음으로
  const rows: ({ line: UtteranceDto } | { steps: AiStep[] })[] = []
  for (const r of timeline) {
    if (r.line) rows.push({ line: r.line })
    else if (r.act) {
      const step = {
        key: r.act.eventId,
        kind: r.act.action,
        text: refineAction(r.act.summaryText),
        atSec: r.act.offsetSeconds,
      }
      const last = rows[rows.length - 1]
      if (last && 'steps' in last) last.steps.push(step)
      else rows.push({ steps: [step] })
    }
  }

  // 표시할 말 — 그 시각 직전(+2초, 음성 인식이 늦게 찍힘)에 시작한 고객 말, 없으면 아무 말
  const lines = q.data ?? []
  const near = (who?: string) =>
    focusSec === null
      ? undefined
      : lines.findLast(
          (l) =>
            (!who || l.speaker === who) &&
            l.offsetSeconds !== null &&
            l.offsetSeconds <= focusSec + 2,
        )
  const marked = (near('CUSTOMER') ?? near())?.callUtteranceSeq ?? null
  useEffect(() => {
    if (marked === null) return
    box.current
      ?.querySelector<HTMLElement>(`[data-key="${marked}"]`)
      ?.scrollIntoView({ block: 'center' })
  }, [marked, acts.data, showAi]) // AI 동작 줄이 늦게 끼어들면 위치가 밀리므로 그때 다시

  if (q.isPending) return <Note>대화를 불러오는 중…</Note>
  if (q.error) return <Note>대화를 불러오지 못했습니다.</Note>
  if (rows.length === 0) return <Note>대화 기록이 없습니다.</Note>
  return (
    <div ref={box} className="flex flex-col gap-0.5">
      {rows.map((r) => {
        if ('steps' in r) return <AiSteps key={`s${r.steps[0].key}`} steps={r.steps} />
        const l = r.line
        return (
          <Talk
            key={l.callUtteranceSeq}
            dataKey={l.callUtteranceSeq}
            ai={l.speaker === 'AI'}
            text={l.utteranceText}
            time={l.offsetSeconds === null ? '' : fmtClock(l.offsetSeconds)}
            marked={l.callUtteranceSeq === marked}
          />
        )
      })}
    </div>
  )
}

const Note = ({ children }: { children: string }) => (
  <p className="py-10 text-center text-[14px] text-ops-sub">{children}</p>
)
