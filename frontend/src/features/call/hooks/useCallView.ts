// 통화 상세 — 대화 · AI 처리 기록 · 녹취는 기존 useCallDetail 그대로, 요약(상태 · 상담 결과 · 불만 · 처리 결과)은 같은 캐시에서 더 꺼냄
import { useQuery } from '@tanstack/react-query'
import { fmtClock, fmtDuration, fmtPhone } from '@/shared/lib/format'
import { LEVEL_TEXT, splitComplaints, TARGET_LABEL } from '@/shared/call/complaints'
import { dateTime } from '@/shared/lib/when'
import { callKinds } from '@/shared/lib/kinds'
import { reasonTag } from '@/shared/lib/unansweredReason'
import { orderNo } from '@/shared/order/labels'
import { callQueries } from '@/shared/call/callApi'
import { toCallDetail, type Complaint } from '@/shared/call/callDto'
import { COMPLAINT_LABEL } from '../labels'
import { useCallDetail } from './useCallDetail'
import { callState, memberOf } from '../callState'

const RESULT_TEXT = {
  ORDER_CREATED: '주문 접수',
  ORDER_CANCELLED: '주문 취소',
  QUESTION_UNANSWERED: 'AI가 답하지 못한 질문',
  HANDOFF_REQUESTED: '상담원 연결 요청',
  INQUIRY: '접수 조회',
  FAQ_ANSWERED: 'FAQ 답변',
} as const

export function useCallView(callId: number) {
  const vm = useCallDetail(callId)
  // 아래 넷은 useCallDetail과 같은 쿼리 — 요청은 한 번 (캐시 공유)
  const detail = useQuery(callQueries.detail(callId))
  const transcript = useQuery(callQueries.transcript(callId))
  const results = useQuery(callQueries.results(callId))
  const actions = useQuery(callQueries.actions(callId))
  const d = detail.data
  const call = d
    ? toCallDetail(d, transcript.data ?? [], results.data ?? [], actions.data ?? [])
    : null

  const split = splitComplaints(call?.complaints ?? [])
  const at = (c: Complaint) => ({
    time: c.offsetSeconds === null ? '' : fmtClock(Math.floor(c.offsetSeconds)),
    go: () => vm.goComplaint(c),
  })
  const summary = call && {
    state: callState(d!.call),
    member: memberOf(d!.call),
    name: call.customerName ?? '',
    phone: call.callerNumber ? fmtPhone(call.callerNumber) : '',
    isNew: call.isNew,
    startedAt: dateTime(call.startedAt),
    duration: call.durationSec === null ? '' : fmtDuration(call.durationSec),
    persona: call.persona ? `${call.persona.name} v${call.persona.version}` : '',
    kinds: callKinds(call.counts),
    analyzed: call.counts !== null,
    // 판정: 고객 불만(대상 · 강도 · 고객이 한 말)과 AI 응대 오류로 나눔. 시각을 누르면 그 말로
    judging: call.counts !== null && call.hasComplaint === null, // 분석 뒤 불만 판정이 아직
    customer: split.customer.map((c) => ({
      label: TARGET_LABEL[c.target],
      level: c.level ? LEVEL_TEXT[c.level] : null,
      quote: c.reason,
      ...at(c),
    })),
    errors: split.errors.map((c) => ({
      label: COMPLAINT_LABEL[c.type],
      reason: c.reason,
      ...at(c),
    })),
    asks: [
      call.callbackAsked && '콜백 요청',
      call.handoffAsked && '상담원 연결 요구',
      call.handoff &&
        `상담원 이관 ${call.handoff.status === 'CONNECTED' ? '연결됨' : call.handoff.status === 'FAILED' ? '실패' : '요청'}`,
    ].filter((x): x is string => !!x),
    results: call.results.map((r) => ({
      key: r.order,
      text: RESULT_TEXT[r.kind],
      order: r.orderSeq ? { seq: r.orderSeq, no: orderNo(r.orderSeq) } : null,
      question: r.question,
      reason: r.kind === 'QUESTION_UNANSWERED' ? reasonTag(r.reason).label : null,
      unansweredSeq: r.unansweredQuestionSeq,
      atSec: r.atSec,
    })),
    // 이 통화에서 접수 · 취소한 주문 (오른쪽 목차의 '주문' — 출발지 · 도착지 · 물품은 주문 상세에서)
    orders: [
      ...new Map(
        call.results
          .filter((r) => r.orderSeq && (r.kind === 'ORDER_CREATED' || r.kind === 'ORDER_CANCELLED'))
          .map((r) => [
            r.orderSeq!,
            r.kind === 'ORDER_CANCELLED' ? ('취소' as const) : ('접수' as const),
          ]),
      ),
    ].map(([seq, what]) => ({ seq, what })),
  }

  // AI 처리 기록을 대화 중 일어난 자리에 끼우려고 시각을 붙임 (기업 피드백: 툴 전환 같은 정보는 대화 중 발생 지점에)
  const atOf = new Map((call?.actions ?? []).map((a) => [a.order, a.atSec]))
  const events = vm.actions.map((a) => ({ ...a, atSec: atOf.get(a.key) ?? null }))

  return { ...vm, summary, events, startedIso: call?.startedAt ?? null }
}

export type CallView = ReturnType<typeof useCallView>
