import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { fmtClock, fmtDetailTime, fmtDuration, fmtPhone } from '@/shared/lib/format'
import type { TagKind } from '@/shared/ui'
import {
  ACTION_LABEL,
  FIELD_LABEL,
  OUTCOME_LABEL,
  OUTCOME_TAG,
  PAYMENT_METHOD_LABEL,
  PAYMENT_STATE_LABEL,
  RELATED_CALL_LABEL,
  RESULT_LABEL,
} from '@/features/call/labels'
import {
  NotFoundError,
  callQueries,
  orderQueries,
  type AiAction,
  type Complaint,
  type OrderDetail,
  type Party,
  type ResultBlock,
  type Utterance,
} from '@/features/call/api/callApi'

/** 스크립트 한 줄 (말만 — AI 동작은 오른쪽 처리 내용으로, 10/30) */
export interface ScriptLine {
  key: number
  time: string // '00:31'
  who: 'AI' | '고객'
  text: string
}
/** 연속 구간: 불만이면 빨간 묶음으로 */
export interface ScriptSegment {
  complaint: Complaint | null
  lines: ScriptLine[]
}

/** 처리 내용 블록 한 개 */
export interface ResultView {
  key: string
  label: string // '접수' · '주문 취소' · 'AI 미답변'
  time: string
  link: { label: string; onClick: () => void }
  question?: string // AI 미답변: 고객 질문
}

/** AI 동작 기록 한 줄 */
export interface ActionView {
  key: number
  time: string
  tag: string // 저장 · 검색 · 취소 · 전송
  text: string
}

/** 주문 팝업 (읽기 전용) */
export interface OrderView {
  title: string
  tags: { label: string; kind: TagKind }[] // [전화] [주문 취소]
  subtitle: string // '접수 10.20 (화) 13:12 · AI 전화 접수'
  sender: [string, string][] // [항목, 값]
  receiver: [string, string][]
  items: string
  info: [string, string][] // 수거 희망 일시 · 결제 방식 · 물품 가액 · 결제 (두 칸씩)
  clientComment: string
  relatedCalls: { key: string; time: string; tag: string; text: string; onClick: () => void }[]
  canEdit: boolean // 취소된 주문은 [수정] 없음
}

const SPEEDS = ['1.0x', '2.0x', '3.0x'] as const
type Speed = (typeof SPEEDS)[number]

function toSegments(utterances: Utterance[], complaints: Complaint[]): ScriptSegment[] {
  const segments: ScriptSegment[] = []
  utterances.forEach((u, i) => {
    const complaint =
      complaints.find((c) => c.fromSec <= u.atSec && u.atSec <= c.toSec) ?? null
    const line: ScriptLine = {
      key: i,
      time: fmtClock(u.atSec),
      who: u.speaker === 'AI' ? 'AI' : '고객',
      text: u.text,
    }
    const last = segments[segments.length - 1]
    if (last && last.complaint === complaint) last.lines.push(line)
    else segments.push({ complaint, lines: [line] })
  })
  return segments
}

/** AI 동작을 읽기 쉬운 말로 — 저장 = '받는 분 전화번호 = 010-2345-6789' (전화번호는 하이픈) */
function actionText(a: AiAction): string {
  if (a.kind !== 'SAVE') return a.text
  const value = a.field.endsWith('phoneNumber') ? fmtPhone(a.value) : a.value
  return `${FIELD_LABEL[a.field]} = ${value}`
}

/** 블록 순서: 주문에 한 일(접수 · 주문 취소)이 위, AI 미답변이 아래 — 같은 무리 안에선 시각 순 (10/28: 미답변이 위면 문의 통화로 읽힘) */
const rank = (r: ResultBlock) => (r.kind === 'UNANSWERED' ? 1 : 0)

const partyRows = (p: Party): [string, string][] => [
  ['이름', p.name],
  ['전화번호', fmtPhone(p.phoneNumber)],
  ['주소', p.roadAddress],
  ['상세주소', p.detailAddress ?? '없음'],
]

/** 06 통화 상세 훅 — 요약 · 스크립트(불만 묶음) · 재생 속도 · 처리 내용 · AI 동작 · 주문 팝업 */
export function useCallDetail(callId: number) {
  const navigate = useNavigate()
  const [speed, setSpeed] = useState<Speed>('1.0x')
  const [orderId, setOrderId] = useState<number | null>(null) // '주문 보기 ›'로 연 주문

  const detail = useQuery(callQueries.detail(callId))
  const order = useQuery({ ...orderQueries.detail(orderId ?? 0), enabled: orderId !== null })

  const errorMessage = (e: Error | null) =>
    !e ? null : e instanceof NotFoundError ? e.message : '불러오지 못했습니다. 다시 시도해 주세요.'

  const call = detail.data

  const results: ResultView[] = call
    ? [...call.results]
        .sort((a, b) => rank(a) - rank(b) || a.atSec - b.atSec)
        .map((r, i) => ({
          key: `${r.kind}-${i}`,
          label: RESULT_LABEL[r.kind],
          time: fmtClock(r.atSec),
          ...(r.kind === 'UNANSWERED'
            ? {
                question: r.question,
                link: { label: 'AI 미답변 보기', onClick: () => navigate('/faqs/unanswered') },
              }
            : { link: { label: '주문 보기', onClick: () => setOrderId(r.orderSeq) } }),
        }))
    : []

  const o = order.data
  const orderView: OrderView | null = o
    ? {
        title: '주문 상세',
        tags: [
          { label: o.route === 'PHONE' ? '전화' : '수기', kind: 'blue' },
          ...(o.cancelled ? [{ label: '주문 취소', kind: 'gray' as TagKind }] : []),
        ],
        subtitle: `접수 ${fmtDetailTime(o.acceptedAt)} · ${o.route === 'PHONE' ? 'AI 전화 접수' : '수기 접수'}`,
        sender: partyRows(o.sender),
        receiver: partyRows(o.receiver),
        items: itemsText(o),
        info: [
          ['수거 희망 일시', fmtDetailTime(o.pickupRequestedAt)],
          ['결제 방식', PAYMENT_METHOD_LABEL[o.paymentMethod]],
          ['물품 가액', `${o.itemPrice.toLocaleString('ko-KR')}원`],
          ['결제', PAYMENT_STATE_LABEL[o.paymentState]],
        ],
        clientComment: o.clientComment ?? '없음',
        relatedCalls: o.relatedCalls.map((c) => ({
          key: `${c.callSessionSeq}-${c.kind}`,
          time: fmtDetailTime(c.startedAt),
          tag: RELATED_CALL_LABEL[c.kind].tag,
          text: RELATED_CALL_LABEL[c.kind].text,
          onClick: () => {
            setOrderId(null)
            navigate(`/calls/${c.callSessionSeq}`)
          },
        })),
        canEdit: !o.cancelled,
      }
    : null

  return {
    isLoading: detail.isPending,
    error: errorMessage(detail.error),

    // 요약 한 줄: 고객 + 통화 결과 · 통화 시작 시각 · 통화 시간 · 발신번호 / 아래 불만 줄
    summary: call
      ? {
          customer: call.customerName,
          outcome: OUTCOME_LABEL[call.outcome],
          outcomeTag: OUTCOME_TAG[call.outcome],
          startedAt: fmtDetailTime(call.startedAt, { seconds: true }),
          duration: fmtDuration(call.durationSec),
          caller: fmtPhone(call.callerNumber),
          complaints: call.complaints,
        }
      : null,

    // 스크립트 (말만) + 재생. ponytail: 녹취 재생(CALL-10)은 명세 · 녹취 저장이 정해지면 — 지금은 자리 · 속도 고르기만
    persona: call ? `${call.persona.name} v${call.persona.version}` : '',
    player: { now: fmtClock(0), length: fmtClock(call?.durationSec ?? 0) },
    speeds: SPEEDS,
    speed,
    setSpeed,
    segments: call ? toSegments(call.utterances, call.complaints) : [],

    // 처리 내용
    results,
    actions: (call?.actions ?? []).map(
      (a, i): ActionView => ({
        key: i,
        time: fmtClock(a.atSec),
        tag: ACTION_LABEL[a.kind],
        text: actionText(a),
      }),
    ),

    // 주문 팝업
    order: orderView, // 다 받으면 팝업이 뜸
    closeOrder: () => setOrderId(null),
    // 03 주문 수정 화면이 아직 없어 03 주문 내역으로 (팀원 03 작업 뒤 그 수정 화면으로 바꿀 것)
    editOrder: () => navigate('/orders'),
  }
}

function itemsText(o: OrderDetail) {
  const i = o.items
  return `서류 ${i.document} · 소박스 ${i.small} · 중박스 ${i.medium} · 대박스 ${i.big} · 기타 ${i.other ?? '—'}`
}
