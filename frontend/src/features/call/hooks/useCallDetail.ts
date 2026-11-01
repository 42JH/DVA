import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '@/shared/api/client'
import { fmtClock, fmtDetailTime, fmtDuration, fmtPhone } from '@/shared/lib/format'
import type { TagKind } from '@/shared/ui'
import {
  ACTION_LABEL,
  COMPLAINT_LABEL,
  NO_ANALYSIS,
  OUTCOME_LABEL,
  OUTCOME_TAG,
  RESULT_LABEL,
} from '@/features/call/labels'
import {
  callQueries,
  type Complaint,
  type ResultBlock,
  type Utterance,
} from '@/features/call/api/callApi'
import { utteranceAt } from '@/features/call/api/callDto'
import { useRecordingPlayer } from './useRecordingPlayer'

/** 스크립트 한 줄 (말만 — AI 동작은 오른쪽 처리 내용으로, 10/30) */
export interface ScriptLine {
  key: number // 발화 순번 (= 서버 order)
  time: string // '00:31' (위치를 모르면 '')
  who: 'AI' | '고객'
  text: string
}
/** 연속 구간: 불만이면 빨간 묶음으로 */
export interface ScriptSegment {
  complaint: { label: string } | null
  lines: ScriptLine[]
}

/** 처리 내용 블록 한 개 */
export interface ResultView {
  key: string
  label: string // '접수' · '주문 취소' · 'AI 미답변' · '상담원 이관 요청'
  time: string
  link?: { label: string; onClick: () => void }
  question?: string // AI 미답변: 고객 질문
}

/** AI 동작 기록 한 줄. onClick = 그 시각의 말로 스크립트를 넘기고 녹취를 거기서부터 재생 (시각을 모르면 없음) */
export interface ActionView {
  key: number
  time: string
  tag: string // 저장 · 검색 · 조회 · 취소 · 전송
  text: string
  onClick?: () => void
}

/** 불만은 발화 순번(utteranceOrders)으로 묶음 (명세 §5.2: 실제 있는 발화만 강조) */
function toSegments(utterances: Utterance[], complaints: Complaint[]): ScriptSegment[] {
  const segments: ScriptSegment[] = []
  for (const u of utterances) {
    const c = complaints.find((x) => x.utteranceOrders.includes(u.order))
    const line: ScriptLine = {
      key: u.order,
      time: u.atSec === null ? '' : fmtClock(u.atSec),
      who: u.speaker === 'AI' ? 'AI' : '고객',
      text: u.text,
    }
    const last = segments[segments.length - 1]
    const sameGroup =
      last && (last.complaint === null) === (c === null) && (!c || last.lines[0].key >= 0)
    if (
      sameGroup &&
      (c === null || complaints.find((x) => x.utteranceOrders.includes(last.lines[0].key)) === c)
    )
      last.lines.push(line)
    else segments.push({ complaint: c ? { label: COMPLAINT_LABEL[c.type] } : null, lines: [line] })
  }
  return segments
}

/** 블록 순서: 주문에 한 일(접수 · 주문 취소 · 이관)이 위, AI 미답변이 아래 — 같은 무리 안에선 통화 순번 (10/28: 미답변이 위면 문의 통화로 읽힘) */
const rank = (r: ResultBlock) => (r.kind === 'QUESTION_UNANSWERED' ? 1 : 0)

/** 06 통화 상세 훅 — 요약 · 스크립트(불만 묶음) · 녹취 재생 · 처리 내용 · AI 동작 · 주문 팝업 */
export function useCallDetail(callId: number) {
  const navigate = useNavigate()
  const [orderId, setOrderId] = useState<number | null>(null) // '주문 보기 ›'로 연 주문
  // AI 동작을 눌러 짚은 통화 안 시각(초)과, 스크립트가 그 줄로 스크롤할 신호 (누를 때마다 n이 늘어 같은 줄도 다시 스크롤)
  const [cursor, setCursor] = useState<number | null>(null)
  const [jump, setJump] = useState<{ key: number; n: number } | null>(null)

  const detail = useQuery(callQueries.detail(callId))
  const call = detail.data
  const player = useRecordingPlayer(call?.recording ?? null, () => {
    void detail.refetch()
  })
  // 지금 짚은 줄: 녹취가 돌면 재생 위치, 아니면 누른 시각 (11/01 사용자: AI 동작을 누르면 왼쪽 그 부분 + 그 부분 음성)
  const at = player.now > 0 ? player.now : cursor
  const focusKey = at === null ? null : (utteranceAt(call?.utterances ?? [], at)?.order ?? null)
  const jumpTo = (sec: number) => {
    const line = utteranceAt(call?.utterances ?? [], sec)
    setCursor(sec)
    if (line) setJump((j) => ({ key: line.order, n: (j?.n ?? 0) + 1 }))
    player.seek(sec)
  }

  const error = !detail.error
    ? null
    : detail.error instanceof ApiError && detail.error.status === 404
      ? '통화를 찾을 수 없습니다.'
      : '불러오지 못했습니다. 다시 시도해 주세요.'

  const results: ResultView[] = call
    ? [...call.results]
        .filter((r) => RESULT_LABEL[r.kind]) // 문의 · 답한 FAQ 블록은 안 그림
        .sort((a, b) => rank(a) - rank(b) || a.order - b.order)
        .map((r) => {
          const base = {
            key: `${r.kind}-${r.order}`,
            label: RESULT_LABEL[r.kind]!,
            time: r.atSec === null ? '' : fmtClock(r.atSec),
          }
          if (r.kind === 'QUESTION_UNANSWERED')
            return r.question === null
              ? base // 삭제된 질문: 원문도 링크도 없음
              : {
                  ...base,
                  question: r.question,
                  // 그 통화의 질문만 (10/30 사용자: 미답변 보기를 누르면 해당 통화 것만)
                  link: {
                    label: 'AI 미답변 보기',
                    onClick: () => navigate(`/faqs/unanswered?call=${callId}`),
                  },
                }
          if (r.orderSeq !== null) {
            const orderSeq = r.orderSeq
            return { ...base, link: { label: '주문 보기', onClick: () => setOrderId(orderSeq) } }
          }
          return base
        })
    : []

  const outcomeView = (
    o: typeof call extends infer T ? (T extends { outcome: infer O } ? O : never) : never,
  ) => (o ? { label: OUTCOME_LABEL[o], tag: OUTCOME_TAG[o] as TagKind } : NO_ANALYSIS)

  return {
    isLoading: detail.isPending,
    error,

    // 요약 한 줄: 고객 + 통화 결과 · 통화 시작 시각 · 통화 시간 · 발신번호 / 아래 불만 줄 (모르는 값은 '—')
    summary: call
      ? {
          customer: call.customerName ?? '—',
          outcome: outcomeView(call.outcome).label,
          outcomeTag: outcomeView(call.outcome).tag,
          startedAt: call.startedAt ? fmtDetailTime(call.startedAt, { seconds: true }) : '—',
          duration: call.durationSec === null ? '—' : fmtDuration(call.durationSec),
          caller: call.callerNumber ? fmtPhone(call.callerNumber) : '—',
          complaints: call.complaints.map((c) => ({
            label: COMPLAINT_LABEL[c.type],
            reason: c.reason,
          })),
        }
      : null,

    // 스크립트 (말만) + 녹취 재생
    persona: call?.persona ? `${call.persona.name} v${call.persona.version}` : '',
    player: {
      state: player.state,
      playing: player.playing,
      now: fmtClock(Math.floor(player.now)),
      length: fmtClock(Math.floor(player.length || call?.durationSec || 0)),
      progress: player.progress,
      toggle: player.toggle,
      src: player.src,
      handlers: player.handlers,
    },
    audioRef: player.audioRef, // <audio>에 꽂을 ref — player와 따로 넘김 (렌더 중 ref 접근 규칙)
    segments: call ? toSegments(call.utterances, call.complaints) : [],
    focusKey, // 옅은 남색으로 짚는 줄 (발화 순번)
    jump, // 그 줄로 스크롤 (AI 동작을 눌렀을 때만 — 재생 중엔 강조만 따라가고 스크롤은 안 함)

    // 처리 내용
    results,
    actions: (call?.actions ?? []).map((a): ActionView => {
      const sec = a.atSec
      return {
        key: a.order,
        time: sec === null ? '' : fmtClock(sec),
        tag: ACTION_LABEL[a.kind],
        text: a.text, // 서버 summaryText 그대로 (AI팀에 읽기 쉬운 문장으로 요청)
        onClick: sec === null ? undefined : () => jumpTo(sec),
      }
    }),
    actionCount: call?.aiActionCount ?? 0,

    // 주문 팝업 (shared/order/OrderDetailModal — 03 주문 내역과 같은 창). 06은 읽기만: [수정]은 03에서 (통화 ≠ 주문, 10/28)
    orderId, // null이 아니면 팝업
    closeOrder: () => setOrderId(null),
  }
}
