// 06 통화 상세 Model — CALL-08 통화 상세 · CALL-09 발화 목록 · ORD-03 주문 상세 · ORD-04 주문 정보 저장 (명세서 12 · 11장)
// 화면은 "통화 하나"만 알면 되게 세 조회를 여기서 한 덩어리(CallDetail)로 합친다. React를 모르는 데이터 · API 층
import { api, type ApiItem, type ApiList } from '../../../shared/api/client'

// ---------- 명세서 DTO (19장) ----------
export interface Call {
  callSessionSeq: number
  providerCallId: string
  callerPhoneNumber: string | null
  orderSeq: number | null
  startedAt: string | null
  endedAt: string | null
  endReason: string | null
  handoff: { status: 'REQUESTED' | 'CONNECTED' | 'FAILED' } | null
  // --- 명세에 없음 → BE 요청안 (대조표 N1 통화 결과 · N2 페르소나 · N3 불만). AI 파트가 통화 종료(CALL-02)에 같이 저장
  outcome?: 'SUCCESS' | 'FAILED' | 'HANDOFF' // 접수 성공 · 접수 실패 · 상담원 이관
  persona?: { name: string; version: number } // '빠른 접수형 v6'
  complaints?: Complaint[]
}

export interface Complaint {
  kind: string // '되묻기 반복'
  reason: string // '번호를 세 번 말하게 되자 짜증 냄'
  fromUtterance: number // 스크립트에서 빨갛게 묶을 구간 (utteranceOrder, 양 끝 포함)
  toUtterance: number
}

export interface Recording {
  recordingSeq: number
  durationSec?: number // 명세 Recording DTO 미확인 — 재생 바 길이용
}

export interface Utterance {
  callUtteranceSeq: number
  utteranceOrder: number
  speaker: 'CUSTOMER' | 'AI'
  utteranceText: string
  lastSentenceSeq: number
  receivedAt: string
  // --- 명세에 없음 → BE 요청안 (N6 AI 동작 줄): 말이 아닌 AI 동작(저장 · 검색 · 전송)은 speaker 'AI' + action
  action?: 'SAVE' | 'SEARCH' | 'SEND'
}

export interface OrderAddressValue {
  name: string | null
  phoneNumber: string | null
  roadAddress: string | null
  jibunAddress: string | null
  detailAddress: string | null
  dongName: string | null
  postalCode: string | null
  latitude: number | null
  longitude: number | null
}

export interface Parcel {
  orderParcelSeq: number
  origin: OrderAddressValue
  destination: OrderAddressValue
  documentCount: number
  smallBoxCount: number
  mediumBoxCount: number
  bigBoxCount: number
  otherItemDescription: string
  clientComment: string // 고객 요청 사항 (접수의 선택 항목, AI 상담원이 통화에서 받아 적음)
  itemPrice: number | null
}

export type PaymentMethodType = 'cat' | 'billing' | 'credit' | 'groupBilling'

export interface Order {
  orderSeq: number
  paymentMethodType: PaymentMethodType
  pickupRequestedAt: string | null
  status:
    | 'COLLECTING'
    | 'SUBMITTING'
    | 'ACCEPTED'
    | 'AUTH_FAILED'
    | 'REVIEW_REQUIRED'
    | 'CANCELLED'
    | 'EXPIRED'
  version: number
  parcelNo: string | null // 디버 접수번호
  parcels: Parcel[]
  // --- 명세에 없음 → BE 요청안 (N7 수정 로그). 수정은 고객 요청 통화에서 AI가 반영하거나, 관리자가 06에서 고친 것
  edits?: OrderEdit[]
}

/** 수정 로그 한 건. field = 화면 칸 키 ('destination.detailAddress' 처럼 상세 0번 기준) */
export interface OrderEdit {
  field: EditableField
  before: string
  after: string
  editedBy: { kind: 'AI' | 'ADMIN'; name: string } // 'AI 상담원' · 관리자 이름
  editedAt: string
  requestCallSessionSeq?: number // 고객이 요청한 통화 문의 (AI 반영일 때)
}

export type EditableField =
  | 'origin.name'
  | 'origin.phoneNumber'
  | 'origin.detailAddress'
  | 'destination.name'
  | 'destination.phoneNumber'
  | 'destination.detailAddress'
  | 'clientComment'

/** 세 조회를 합친 화면용 묶음 */
export interface CallDetail {
  call: Call
  recordings: Recording[]
  utterances: Utterance[]
  order: Order | null // 주문 없는 통화(접수 실패 · 이관)면 null
}

export const callKeys = {
  detail: (id: number) => ['calls', id] as const,
}

/** CALL-09 — 100줄씩 끝(hasNext=false)까지. 긴 통화도 스크립트가 잘리지 않게 */
async function fetchTranscript(id: number, signal?: AbortSignal): Promise<Utterance[]> {
  const all: Utterance[] = []
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await api.get<ApiList<Utterance>>(`/calls/${id}/transcript`, {
      query: { limit: 100, offset },
      signal,
    })
    all.push(...page.data)
    if (!page.hasNext) break
  }
  return all
}

/** CALL-08 + CALL-09 + ORD-03 */
export async function fetchCallDetail(id: number, signal?: AbortSignal): Promise<CallDetail> {
  const [detail, utterances] = await Promise.all([
    api.get<ApiItem<{ call: Call; recordings: Recording[] }>>(`/calls/${id}`, { signal }),
    fetchTranscript(id, signal),
  ])
  const { call, recordings } = detail.data
  const order =
    call.orderSeq === null
      ? null
      : (await api.get<ApiItem<Order>>(`/orders/${call.orderSeq}`, { signal })).data
  return { call, recordings, utterances, order }
}

/**
 * ORD-04 — 관리자가 AI가 잘못 받아 적은 칸 하나를 고침 (수정 사유 없음, 10/21 결정).
 * 명세의 ORD-04는 미완료 주문용이라 접수된 주문 수정은 대조표 D1(동결)과 충돌 — BE 결정 전까지 가짜만 응답
 */
export function patchOrderField(order: Order, field: EditableField, value: string): Promise<void> {
  const parcel = order.parcels[0]
  const [side, key] = field.split('.') as [string, string]
  // 전화번호는 숫자만 (명세: 숫자 문자열, 선행 0 유지) · 빈 값은 null = 비우기 (OrderAddressPatch) · 요청 사항은 빈 문자열 허용
  const sent = field.endsWith('phoneNumber') ? value.replace(/\D/g, '') : value
  const body =
    field === 'clientComment'
      ? {
          expectedVersion: order.version,
          parcels: [{ orderParcelSeq: parcel.orderParcelSeq, clientComment: sent }],
        }
      : {
          expectedVersion: order.version,
          parcels: [{ orderParcelSeq: parcel.orderParcelSeq, [side]: { [key]: sent || null } }],
        }
  return api.patch(`/orders/${order.orderSeq}`, { body })
}
