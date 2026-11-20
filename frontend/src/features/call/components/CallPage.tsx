// 통화 상세
// 위 띠: 고객 · 상태 · 시작 · 통화 시간 · AI 상담가 · 고객 용건
// 왼쪽 대화: 한 줄 기록 (이름 · 말 · 시각). AI 동작(주소 검색 · 저장 · 접수 전송 등)은 그 말 아래 들여 쓴 줄로
// 오른쪽: 운영팀용 정보 — 고객, 이 통화의 주문(출발지 · 도착지 · 물품), 처리 결과, 불만
// FAQ 사례 · 미답변에서 오면 그 말로 스크롤해 표시 (location.state: at = 그 말의 시각 ISO, unanswered = 미답변 번호)
import { useEffect, useRef, useState, type RefObject } from 'react'
import { useLocation, useParams } from 'react-router'
import { useFollowScroll } from '@/shared/call/useFollowScroll'
import { PageHead } from '@/shared/ui'
import { Badge, Kinds } from '@/shared/ui'
import { useCallView, type CallView } from '../hooks/useCallView'
import { Contents } from './CallContents'
import { Player } from '@/shared/call/Player'
import { AiSteps, AiToggle, Talk } from '../../../shared/call/AiSteps'
import { useShowAi } from '@/shared/lib/useShowAi'
import { useKeepScroll } from '@/shared/lib/keepScroll'

type Line = CallView['segments'][number]['lines'][number]
type Event = CallView['events'][number]
type Arrival = { at?: string; unanswered?: number; from?: string } | null

/** 뒤로 가면 들어온 화면으로 — 미답변 · 주문에서 왔으면 그 화면 이름 */
const backLabel = (from: string) =>
  from.startsWith('/unanswered')
    ? '미답변 문의로'
    : from.startsWith('/orders')
      ? '주문으로'
      : '통화 목록으로'

export function CallPage() {
  const { callId } = useParams()
  return <CallBody key={callId} callId={Number(callId)} />
}

function CallBody({ callId }: { callId: number }) {
  const vm = useCallView(callId)
  const [showAi, setShowAi] = useShowAi()
  const arrival = useLocation().state as Arrival
  const from = arrival?.from ?? '/calls'
  const s = vm.summary

  return (
    <>
      <PageHead title={`통화 #${callId}`} back={{ to: from, label: backLabel(from) }}></PageHead>
      {vm.error ? (
        <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
          {vm.error}
        </p>
      ) : (
        <>
          {s && (
            <div className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-2 border-b border-ops-line bg-white px-6 py-3">
              <span className="flex items-baseline gap-2">
                {/* 고객으로 못 찾은 번호(API customerSeq · customerName null)는 고객이 아님 → 번호를 이름 자리에 */}
                <span className="text-[17px] font-bold tabular-nums">{s.name || s.phone}</span>
                {s.name && <span className="text-[14px] text-ops-sub tabular-nums">{s.phone}</span>}
              </span>
              <Badge tone={s.state.tone}>{s.state.label}</Badge>
              <Fact label="시작">{s.startedAt}</Fact>
              <Fact label="통화 시간">{s.duration}</Fact>
              <Fact label="AI 상담가">{s.persona}</Fact>
              {s.analyzed && (
                <span className="flex gap-1">
                  <Kinds kinds={s.kinds} />
                </span>
              )}
              <span className="ml-auto">
                <AiToggle on={showAi} onChange={setShowAi} />
              </span>
            </div>
          )}
          {vm.notice && (
            <p
              role="status"
              className="shrink-0 bg-ops-wait-soft px-6 py-1.5 text-[12px] text-ops-wait"
            >
              {vm.notice}
            </p>
          )}
          <div className="flex min-h-0 flex-1">
            <Chat vm={vm} arrival={arrival} showAi={showAi} />
            <Contents vm={vm} />
          </div>
          <Player player={vm.player} audioRef={vm.audioRef} />
        </>
      )}
    </>
  )
}

function Fact({ label, children }: { label: string; children: string }) {
  if (!children) return null
  return (
    <span className="text-[13px]">
      <span className="text-ops-sub">{label} </span>
      <span className="font-medium tabular-nums">{children}</span>
    </span>
  )
}

/** 대화 — 말풍선 사이에 그 시각의 AI 처리 기록. 재생 중이면 지금 말을 따라 내려감 */
function Chat({ vm, arrival, showAi }: { vm: CallView; arrival: Arrival; showAi: boolean }) {
  const list = useRef<HTMLDivElement>(null)
  const back = useKeepScroll(list, 'chat')
  const touched = useFollowScroll(list, vm.focusKey, vm.player.playing, vm.jump)
  const lines = vm.segments.flatMap((g) => g.lines)
  const marked = useArrival(list, lines, vm, back ? null : arrival) // 뒤로 왔으면 보던 곳 그대로

  // AI 처리 기록 → 그 시각 직전에 시작한 말 아래에 붙임 (시각을 모르면 맨 끝)
  const after = new Map<number | 'end', Event[]>()
  for (const e of vm.events) {
    const at = e.atSec
    const host = at === null ? undefined : lines.findLast((l) => l.atSec !== null && l.atSec <= at)
    const k = host ? host.key : at === null ? 'end' : (lines[0]?.key ?? 'end')
    after.set(k, [...(after.get(k) ?? []), e])
  }
  const steps = (k: number | 'end') => (showAi ? (after.get(k) ?? []) : [])
  const row = (l: Line) => (
    <div key={l.key}>
      <Talk
        ai={l.who === 'AI'}
        text={l.text}
        time={l.time}
        on={l.key === vm.focusKey}
        marked={l.key === marked}
        flag={l.complaint}
        onClick={l.onClick}
        dataKey={l.key}
      />
      <AiSteps steps={steps(l.key)} />
    </div>
  )

  return (
    <div
      ref={list}
      onWheel={touched}
      onTouchMove={touched}
      // 스크롤 막대 끌기(목록 자체를 누름) · 키보드 스크롤도 사람이 움직인 것
      onPointerDown={(e) => e.target === e.currentTarget && touched()}
      onKeyDown={(e) =>
        ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key) &&
        touched()
      }
      aria-label="통화 대화"
      className="relative flex min-h-0 min-w-0 flex-1 [scrollbar-width:thin] flex-col gap-0.5 overflow-y-auto bg-white px-4 py-4"
    >
      {lines.length === 0 && (
        <p className="m-auto text-center text-[14px] text-ops-sub">
          {vm.isLoading ? '불러오는 중…' : vm.scriptEmpty}
        </p>
      )}
      {vm.segments.map((seg, i) =>
        seg.complaint ? (
          // AI 응대 오류 구간 — 왼쪽 주황 줄 + 이름 (상자로 감싸지 않음). 고객 불만은 그 고객 말만 표시(Talk flag)
          <div key={i} className="my-1 flex flex-col gap-0.5 border-l-2 border-ops-wait">
            <p className="px-3 pt-1 text-[12px] font-semibold text-ops-wait">
              AI 오류: {seg.complaint.label}
            </p>
            {seg.lines.map(row)}
          </div>
        ) : (
          seg.lines.map(row)
        ),
      )}
      <AiSteps steps={steps('end')} />
    </div>
  )
}

/** FAQ 사례 · 미답변에서 왔으면 그 말을 찾아 가운데로 스크롤하고 잠깐 표시 */
function useArrival(
  list: RefObject<HTMLDivElement | null>,
  lines: Line[],
  vm: CallView,
  arrival: Arrival,
) {
  let sec: number | null = null
  if (arrival?.unanswered != null)
    sec = vm.summary?.results.find((r) => r.unansweredSeq === arrival.unanswered)?.atSec ?? null
  else if (arrival?.at && vm.startedIso)
    sec = (Date.parse(arrival.at) - Date.parse(vm.startedIso)) / 1000
  // 그 시각 직전에 시작한 고객 말 (질문은 고객이 함), 없으면 아무 말
  const near = (who?: string) =>
    sec === null
      ? undefined
      : lines.findLast((l) => (!who || l.who === who) && l.atSec !== null && l.atSec <= sec + 2)
  const key = (near('고객') ?? near())?.key ?? null
  const [shown, setShown] = useState<number | null>(null)
  useEffect(() => {
    if (key === null) return
    const box = list.current
    const el = box?.querySelector<HTMLElement>(`[data-key="${key}"]`)
    if (box && el) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.offsetHeight / 2 })
    const on = setTimeout(() => setShown(key), 0)
    const off = setTimeout(() => setShown(null), 2400)
    return () => {
      clearTimeout(on)
      clearTimeout(off)
    }
  }, [key, list])
  return shown
}
