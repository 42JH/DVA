import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '../../../shared/api/client'
import { fmtClock, fmtDateTimeDay, fmtPhone } from '../../../shared/lib/format'
import {
  callKeys,
  fetchCallDetail,
  patchOrderField,
  type Complaint,
  type EditableField,
  type Order,
  type OrderEdit,
  type Utterance,
} from '../model/callApi'

export type { EditableField, OrderEdit } from '../model/callApi'

export type Outcome = '접수 성공' | '접수 실패' | '상담원 이관'
const OUTCOME: Record<NonNullable<ReturnType<typeof outcomeOf>>, Outcome> = {
  SUCCESS: '접수 성공',
  FAILED: '접수 실패',
  HANDOFF: '상담원 이관',
}
const outcomeOf = (c: { outcome?: 'SUCCESS' | 'FAILED' | 'HANDOFF'; handoff: unknown }) =>
  c.outcome ?? (c.handoff ? 'HANDOFF' : undefined)

const ACTION_LABEL = { SAVE: '저장', SEARCH: '검색', SEND: '전송' } as const
const PAYMENT_LABEL = {
  cat: '지점 방문',
  billing: '개인 카드',
  credit: '월결제',
  groupBilling: '그룹 카드',
} as const

/** 스크립트 한 줄 (view는 그리기만) */
export interface ScriptLine {
  order: number
  time: string // '00:31'
  who: 'AI' | '고객' | '저장' | '검색' | '전송'
  isAction: boolean
  text: string
}
/** 연속 구간: 불만이면 빨간 묶음으로 */
export interface ScriptSegment {
  complaint: Complaint | null
  lines: ScriptLine[]
}

/** 통화 결과 카드의 칸 하나 */
export interface ResultField {
  key:
    | EditableField
    | 'origin.roadAddress'
    | 'destination.roadAddress'
    | 'pickupRequestedAt'
    | 'items'
    | 'paymentMethodType'
  label: string
  value: string
  editable: boolean // 이름 · 전화번호 · 상세주소 · 고객 요청 사항만 (주소는 주소 검색으로만, 품목 · 결제는 고정)
  fixed?: boolean // '고정' 표시 (결제 방식)
  edit?: OrderEdit // 마지막 수정 로그 → [수정됨] + 툴팁
}

const secondsBetween = (from: string, to: string) =>
  Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000))

function toSegments(
  utterances: Utterance[],
  complaints: Complaint[],
  startedAt: string | null,
  showActions: boolean,
) {
  const lines: ScriptLine[] = utterances
    .filter((u) => showActions || !u.action)
    .map((u) => ({
      order: u.utteranceOrder,
      time: fmtClock(startedAt ? secondsBetween(startedAt, u.receivedAt) : 0),
      who: u.action ? ACTION_LABEL[u.action] : u.speaker === 'AI' ? 'AI' : '고객',
      isAction: !!u.action,
      text: u.utteranceText,
    }))
  const segments: ScriptSegment[] = []
  for (const line of lines) {
    const complaint =
      complaints.find((c) => c.fromUtterance <= line.order && line.order <= c.toUtterance) ?? null
    const last = segments[segments.length - 1]
    if (last && last.complaint === complaint) last.lines.push(line)
    else segments.push({ complaint, lines: [line] })
  }
  return segments
}

function toFields(order: Order): { title: string; fields: ResultField[] }[] {
  const p = order.parcels[0]
  const lastEdit = (key: string) => [...(order.edits ?? [])].reverse().find((e) => e.field === key)
  const side = (title: string, which: 'origin' | 'destination') => {
    const a = p[which]
    const f = (
      key: EditableField | `${typeof which}.roadAddress`,
      label: string,
      value: string | null,
      editable: boolean,
    ): ResultField => ({
      key,
      label,
      value: value || '—',
      editable,
      edit: lastEdit(key),
    })
    return {
      title,
      fields: [
        f(`${which}.name`, '이름', a.name, true),
        f(`${which}.phoneNumber`, '전화번호', a.phoneNumber && fmtPhone(a.phoneNumber), true),
        f(`${which}.roadAddress`, '주소', a.roadAddress, false),
        f(`${which}.detailAddress`, '상세주소', a.detailAddress, true),
      ],
    }
  }
  const items = `서류 ${p.documentCount} · 소형 ${p.smallBoxCount} · 중형 ${p.mediumBoxCount} · 대형 ${p.bigBoxCount} · 기타 ${p.otherItemDescription || '—'}`
  return [
    side('보내는 분', 'origin'),
    side('받는 분', 'destination'),
    {
      title: '접수 정보',
      fields: [
        {
          key: 'pickupRequestedAt',
          label: '수거 희망 일시',
          value: order.pickupRequestedAt ? fmtDateTimeDay(order.pickupRequestedAt) : '—',
          editable: false,
        },
        { key: 'items', label: '품목', value: items, editable: false },
        {
          key: 'clientComment',
          label: '고객 요청 사항',
          value: p.clientComment || '없음',
          editable: true,
          edit: lastEdit('clientComment'),
        },
        {
          key: 'paymentMethodType',
          label: '결제 방식',
          value: PAYMENT_LABEL[order.paymentMethodType],
          editable: false,
          fixed: true,
        },
      ],
    },
  ]
}

/** 06 통화 상세 ViewModel — 조회 · AI 동작 토글 · 스크립트 묶기 · 결과 칸 · 관리자 수정 */
export function useCallDetailViewModel(callId: number) {
  const qc = useQueryClient()
  const [showActions, setShowActions] = useState(true) // 'AI 동작 표시'
  // original = 고치기 전 값. 안 바꾸고 저장하면 요청 없이 닫음 (빈 수정 로그가 쌓이지 않게)
  const [editing, setEditing] = useState<{
    key: EditableField
    value: string
    original: string
  } | null>(null)

  const detail = useQuery({
    queryKey: callKeys.detail(callId),
    queryFn: ({ signal }) => fetchCallDetail(callId, signal),
  })

  const save = useMutation({
    mutationFn: () => patchOrderField(detail.data!.order!, editing!.key, editing!.value.trim()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: callKeys.detail(callId) })
      setEditing(null)
    },
  })

  const d = detail.data
  const call = d?.call
  const startedAt = call?.startedAt ?? null
  const durationSec =
    d?.recordings[0]?.durationSec ??
    (call?.startedAt && call.endedAt ? secondsBetween(call.startedAt, call.endedAt) : 0)
  const outcomeKey = call ? outcomeOf(call) : undefined

  const errorMessage = (e: unknown) =>
    e instanceof ApiError && e.status === 404
      ? '통화를 찾을 수 없습니다.'
      : e instanceof Error
        ? e.message
        : null

  return {
    isLoading: detail.isPending,
    error: errorMessage(detail.error),

    // 요약 한 줄
    summary: call
      ? {
          orderNo: call.orderSeq !== null ? String(call.orderSeq) : '—',
          outcome: outcomeKey ? OUTCOME[outcomeKey] : null,
          parcelNo: d?.order?.parcelNo ?? '—',
          startedAt: startedAt
            ? `${fmtDateTimeDay(startedAt)}:${String(new Date(startedAt).getSeconds()).padStart(2, '0')}`
            : '—',
          duration: fmtClock(durationSec),
          caller: call.callerPhoneNumber ? fmtPhone(call.callerPhoneNumber) : '—',
          persona: call.persona ? `${call.persona.name} v${call.persona.version}` : '—',
          complaints: call.complaints ?? [],
        }
      : null,

    // 스크립트
    showActions,
    setShowActions,
    player: {
      now: '00:00',
      length: fmtClock(durationSec),
      hasRecording: (d?.recordings.length ?? 0) > 0,
    },
    segments: d ? toSegments(d.utterances, call?.complaints ?? [], startedAt, showActions) : [],

    // 통화 결과
    sections: d?.order ? toFields(d.order) : [],
    hasOrder: !!d?.order,

    // 관리자 수정 (칸 하나씩)
    editing,
    startEdit: (key: EditableField, value: string) => {
      save.reset()
      const v = value === '—' || value === '없음' ? '' : value
      setEditing({ key, value: v, original: v })
    },
    setEditValue: (value: string) => setEditing((e) => (e ? { ...e, value } : e)),
    cancelEdit: () => setEditing(null),
    saveEdit: () => {
      if (!editing || save.isPending) return
      if (editing.value.trim() === editing.original)
        setEditing(null) // 그대로면 저장 없이 닫음
      else save.mutate()
    },
    isSaving: save.isPending,
    saveError: errorMessage(save.error),
  }
}
