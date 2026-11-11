// 04 · 06 서버 DTO (연동 상세명세 10/31 §13: CallListItem · CallDetail · CallAnalysis · CallComplaint · Recording · Utterance · CallAction · CallProcessingResult)
// + 화면 모양으로 바꾸는 순수 변환. '@/'는 타입만 import — `npx tsx src/features/call/api/callDto.test.ts` 로 바로 돌리려고
import type { UnansweredReason } from '@/shared/lib/unansweredReason'
import { countsOf, type CallKind } from '../lib/callKind' // 값 import라 상대 경로 (위 주석: tsx로 바로 돌림)

// ---------- 서버 DTO ----------
type ResultDto = 'REGISTERED' | 'REGISTRATION_FAILED' | 'HANDOFF' | 'CANCELLED' | 'INQUIRY'
export type ComplaintType =
  | 'REPEATED_QUESTION'
  | 'SPEAKING_TOO_FAST'
  | 'RECOGNITION_FAILURE'
  | 'SLOW_RESPONSE'
  | 'AI_REFUSAL'
  // 11/04 대시보드 연동 명세 §4로 더해진 다섯 (AI 새 불편 유형 — 위 넷은 과거 유형, SLOW_RESPONSE는 둘 다)
  | 'INFORMATION_RECOGNITION_ERROR'
  | 'INTENT_RECOGNITION_ERROR'
  | 'UNSUPPORTED_ANSWER'
  | 'INTERRUPTION'
  | 'DISSATISFACTION_EXPRESSION'
export type CallActionKind =
  | 'PIN_SEARCH'
  | 'PREVIOUS_ORDER_SEARCH'
  | 'CUSTOMER_LOOKUP'
  | 'FAQ_SEARCH'
  | 'FIELD_SAVED'
  | 'ORDER_SUBMITTED'
  | 'ORDER_CANCELLED'
  | 'ADDRESS_SEARCH'
  | 'ORDER_LOOKUP'
export type ProcessingKind =
  | 'ORDER_CREATED'
  | 'ORDER_CANCELLED'
  | 'QUESTION_UNANSWERED'
  | 'HANDOFF_REQUESTED'
  | 'INQUIRY'
  | 'FAQ_ANSWERED'

/** 고객 불만(DISSATISFACTION_EXPRESSION)의 대상 · 강도 (11/11 백엔드 !476). 다른 유형 · 그 전 판정은 null 또는 칸 없음 */
export type ComplaintTarget = 'ai_service' | 'price_policy' | 'delivery_other'
export type ComplaintLevel = 'explicit' | 'mild'
interface CallComplaintDto {
  type: ComplaintType
  evidenceText: string // 고객 불만이면 고객이 한 말 그대로
  offsetSeconds: number | null
  utteranceOrders: number[]
  target?: ComplaintTarget | null
  level?: ComplaintLevel | null
}
export interface CallAnalysisDto {
  result: ResultDto // 11/04 서버에서 빠짐 — 옛 화면(주문 상세 관련 통화)만 아직 읽음. 그 화면을 새 디자인으로 바꿀 때 지울 것
  aiPersonaVersionSeq: number | null
  personaName: string | null
  personaVersion: number | null
  aiStartedAt: string
  aiEndedAt: string
  repeatQuestionCount: number | null
  hasComplaint: boolean | null
  complaints: CallComplaintDto[]
  analysedAt: string
  // 통화 요약 (연동 명세 11/04 §3) — 한 통화가 접수 · 조회 · 취소 · FAQ를 같이 가질 수 있음. null = 이 분석에선 못 모음(0으로 보지 않음)
  // 연동 전 서버엔 칸이 없음(undefined) → null로 봄
  isNewCustomer?: boolean | null
  registeredParcelCount?: number | null // 접수 확정 배송 상세 수
  orderLookupCount?: number | null // 접수 조회 안내 수
  cancelledParcelCount?: number | null // 취소 완료 배송 상세 수
  faqAnswerCount?: number | null // FAQ 답변 수
  // AI 판정 요구 여부 (null = 미수집). 서로 별개, 상담원 연결 요구 ≠ 실제 연결(call.handoff)
  hasCallbackRequest?: boolean | null
  hasHandoffRequest?: boolean | null
}
interface HandoffDto {
  handoffRequestSeq: number
  reason: string
  status: 'REQUESTED' | 'CONNECTED' | 'FAILED'
  assignedAdminUserSeq: number | null
  summaryText: string | null
  requestedAt: string
}
export interface CallDto {
  callSessionSeq: number
  customerSeq: number | null
  customerName: string | null
  organizationName: string | null // 고객의 지금 소속 기업 (없으면 null — 고객 있으면 개인, 둘 다 없으면 미확인)
  // 백엔드 판정 (11/08) · EXPIRED = 분석도 실패 통보도 없이 통화가 끝난 지 10분 지남 (11/09 후속 명세, 배포 전엔 안 옴)
  analysisStatus: 'PENDING' | 'COMPLETED' | 'FAILED' | 'EXPIRED'
  recordedAt: string | null // 첫 녹취가 DB에 저장된 시각 (재생 가능 여부 아님)
  callerPhoneNumber: string | null
  orderSeq: number | null
  orderStatus: string | null
  startedAt: string | null // PBX 시작. 미수집 null
  endedAt: string | null
  endReason: string | null
  handoff: HandoffDto | null
}
export interface CallListItemDto extends CallDto {
  analysis: CallAnalysisDto | null // 아직 안 왔으면 null — 성공 · 불만 없음으로 보지 않기 (§5.1)
}
export interface RecordingDto {
  recordingSeq: number
  createdAt: string
  url: string | null // 최대 5분 유효, 발급 실패 null
  expiresAt: string | null
  playbackError: 'NOT_FOUND' | 'DEPENDENCY_UNAVAILABLE' | null
}
export interface CallDetailDto {
  call: CallDto
  analysis: CallAnalysisDto | null // data.analysis (call.analysis 아님)
  aiActionCount: number
  recordings: RecordingDto[]
}
export interface UtteranceDto {
  callUtteranceSeq: number
  utteranceOrder: number
  speaker: 'CUSTOMER' | 'AI'
  utteranceText: string // 줄바꿈 포함 가능
  lastSentenceSeq: number
  receivedAt: string
  offsetSeconds: number | null
}
export interface CallActionDto {
  eventId: string
  eventOrder: number
  occurredAt: string
  offsetSeconds: number | null
  summaryText: string
  orderSeq: number | null
  action: CallActionKind
}
export interface CallProcessingResultDto extends Omit<CallActionDto, 'action'> {
  action: ProcessingKind
  unansweredQuestionSeq: number | null
  unansweredReason?: UnansweredReason | null // 연결된 미답변의 사유 (11/04). 다른 결과 · 미분류 · 삭제한 미답변은 null, 연동 전 서버는 칸 없음
  questionText: string | null // 미답변 삭제 뒤 null
  answerText: string | null
  faqEntrySeq: number | null // 사용 FAQ가 하나면 그 번호, 여럿이면 null
  faqEntrySeqs?: number[] | null // 사용 FAQ 번호들 (11/05 — FAQ 응대 한 건에 여럿). FAQ 응대가 아니면 null, 구버전 서버는 칸 없음
  questionUtteranceOrder: number | null
  answerUtteranceOrder: number | null
}

// ---------- 화면 모양 ----------
export type { CallKind } // 상담 유형 (접수 · 조회 · 취소 · FAQ 칩) — 주문 상세도 써서 shared/lib/callKind
interface CallRow {
  callSessionSeq: number
  startedAt: string | null
  company: string | null // 소속 기업명 (null = 없음 · 개인 · 서버가 아직 안 줌)
  customerName: string | null
  callerNumber: string // 숫자만. 모르면 ''
  isNew: boolean | null // 신규 고객 (null = 모름)
  counts: Record<CallKind, number | null> | null // null = 분석 전
  hasComplaint: boolean | null // null = 불만 판정 전 (분석 뒤 따로 판정)
  complaints: Complaint[]
  persona: string | null // 실제로 받은 상담가 이름 (그 버전의 이름 — 분석 전이면 null)
  durationSec: number | null
  callbackAsked: boolean | null // 콜백 요청 (null = 모름 — 아님으로 보지 않기)
  handoffAsked: boolean | null // 상담원 연결 요구 (AI 판정, 연결 성공 아님)
}
export interface Complaint {
  type: ComplaintType
  reason: string
  offsetSeconds: number | null
  utteranceOrders: number[] // 스크립트에서 묶을 발화 순번 (빈 배열 = 모름)
  target: ComplaintTarget | null
  level: ComplaintLevel | null
}
export interface Utterance {
  order: number
  atSec: number | null
  speaker: 'AI' | 'CUSTOMER'
  text: string
}
/** 그 시각(초)에 하던 말 = 시각을 아는 발화 중 sec 이전의 마지막 (06: 재생 위치 → 줄 강조). 없으면 null */
export function utteranceAt(utterances: Utterance[], sec: number): Utterance | null {
  let hit: Utterance | null = null
  for (const u of utterances) if (u.atSec !== null && u.atSec <= sec) hit = u
  return hit
}

const norm = (s: string) => s.replace(/[^0-9A-Za-z가-힣]/g, '')
/** AI 동작(시각 sec · 설명 text)을 부른 고객 말 (06 AI 동작 → 스크립트 줄). 동작 시각은 AI가 확인을 되묻고 고객이 "네." 한 뒤라서 바로 앞 말로는 안 맞음
 *  ① 'field = 값'이면 값 조각(2자 이상)이 가장 많이 들어 있는 고객 말 (같으면 나중 것)
 *  ② 없으면 짧은 대답("네." 같은 3자 이하)은 건너뛴 바로 앞 고객 말 ③ 그것도 없으면 그 시각의 아무 말
 *  ponytail: 글자 맞추기 휴리스틱 — AI팀이 동작에 '부른 발화 순번'을 넣어 주면 그걸로 바꿀 것 */
export function utteranceForAction(
  utterances: Utterance[],
  sec: number,
  text: string,
): Utterance | null {
  const said = utterances.filter(
    (u): u is Utterance & { atSec: number } =>
      u.speaker === 'CUSTOMER' && u.atSec !== null && u.atSec <= sec,
  )
  const eq = text.indexOf('=')
  const tokens = (eq < 0 ? '' : text.slice(eq + 1))
    .split(/\s+/)
    .map(norm)
    .filter((t) => t.length >= 2)
  if (tokens.length) {
    let best: Utterance | null = null
    let bestN = 0
    for (const u of said) {
      const n = tokens.filter((t) => norm(u.text).includes(t)).length
      if (n > 0 && n >= bestN) [best, bestN] = [u, n]
    }
    if (best) return best
  }
  for (let i = said.length - 1; i >= 0; i--) if (norm(said[i].text).length > 3) return said[i]
  return said[said.length - 1] ?? utteranceAt(utterances, sec)
}
export interface AiAction {
  order: number
  atSec: number | null
  kind: CallActionKind
  text: string // 서버 summaryText 그대로
}
interface ResultBlock {
  order: number
  atSec: number | null
  kind: ProcessingKind
  orderSeq: number | null
  question: string | null
  unansweredQuestionSeq: number | null
  reason: UnansweredReason | null // AI 미답변 사유 (null = 미분류 · 다른 결과)
}
export interface Recording {
  recordingSeq: number // 재조회마다 서명 URL 글자가 바뀌어도 같은 녹취인지 보는 열쇠 (11/02 연동 명세)
  url: string | null
  expiresAt: string | null
  error: RecordingDto['playbackError']
}
interface CallDetail {
  callSessionSeq: number
  customerName: string | null
  startedAt: string | null
  durationSec: number | null
  callerNumber: string
  isNew: boolean | null // 신규 고객 (null = 모름) — 04 줄과 같은 값
  counts: CallRow['counts'] // 상담 유형 횟수 (null = 분석 전) — 04 줄과 같은 값
  persona: { name: string; version: number } | null
  handoff: { status: HandoffDto['status']; reason: string } | null // 실제 이관 요청 기록
  callbackAsked: boolean | null // 04 줄과 같은 값
  handoffAsked: boolean | null // AI 판정 요구 — handoff(기록)와 다를 수 있음
  hasComplaint: boolean | null
  complaints: Complaint[]
  utterances: Utterance[]
  actions: AiAction[]
  results: ResultBlock[]
  aiActionCount: number
  recording: Recording | null // 첫 녹취 (url 있는 것 우선). 빈 배열(아직 연결 안 됨)이면 null
}

const toComplaints = (a: CallAnalysisDto | null | undefined): Complaint[] =>
  (a?.complaints ?? []).map((c) => ({
    type: c.type,
    reason: c.evidenceText,
    offsetSeconds: c.offsetSeconds,
    utteranceOrders: c.utteranceOrders,
    target: c.target ?? null,
    level: c.level ?? null,
  }))

const digits = (phone: string | null) => (phone ?? '').replace(/\D/g, '')

/** 통화 시간 = PBX 종료 − 시작 (초). 한쪽이라도 없으면 null */
export function durationSec(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null
  return Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
}

/** 고객을 못 찾은 통화(번호만 있음)는 AI가 신규라 해도 신규로 안 봄 — 미등록 발신자를 신규로 부를지 팀 결정 전 (11/10) */
function isNewOf(c: CallDto, isNewCustomer: boolean | null | undefined): boolean | null {
  if (c.customerSeq === null || c.customerName === null) return null
  return isNewCustomer ?? null
}

export function toCallRow(d: CallListItemDto): CallRow {
  const a = d.analysis
  return {
    callSessionSeq: d.callSessionSeq,
    startedAt: d.startedAt,
    customerName: d.customerName,
    company: d.organizationName ?? null,
    callerNumber: digits(d.callerPhoneNumber),
    isNew: isNewOf(d, a?.isNewCustomer),
    counts: countsOf(a),
    hasComplaint: a ? a.hasComplaint : null,
    complaints: toComplaints(a),
    persona: a?.personaName ?? null,
    durationSec: durationSec(d.startedAt, d.endedAt),
    callbackAsked: a?.hasCallbackRequest ?? null,
    handoffAsked: a?.hasHandoffRequest ?? null,
  }
}

/** 04 화면 거르기 — 서버에 없는 조건이라 고른 날의 통화를 다 받은 뒤 화면에서 (필터 창) */
export interface CallFilter {
  newOnly: boolean // 신규 고객만
  kinds: CallKind[] // 이 중 하나라도 한 통화 (빈 배열 = 전체)
  minSec: number // 통화 시간 아래 끝 (0 = 제한 없음)
  maxSec: number | null // 위 끝 (null = 제한 없음)
}
/** 신규 · 유형 · 시간은 모르면(null) 그 조건이 있을 때 뺌 — 모르는 값을 '아님'이나 0으로 보지 않음 */
export function matchCall(r: CallRow, f: CallFilter): boolean {
  if (f.newOnly && r.isNew !== true) return false
  if (f.kinds.length && !f.kinds.some((k) => (r.counts?.[k] ?? 0) > 0)) return false
  if (f.minSec > 0 || f.maxSec !== null)
    return (
      r.durationSec !== null &&
      r.durationSec >= f.minSec &&
      (f.maxSec === null || r.durationSec <= f.maxSec)
    )
  return true
}

export function toCallDetail(
  d: CallDetailDto,
  utterances: UtteranceDto[],
  results: CallProcessingResultDto[],
  actions: CallActionDto[],
): CallDetail {
  const a = d.analysis
  const rec = d.recordings.find((r) => r.url) ?? d.recordings[0]
  return {
    callSessionSeq: d.call.callSessionSeq,
    customerName: d.call.customerName,
    startedAt: d.call.startedAt,
    durationSec: durationSec(d.call.startedAt, d.call.endedAt),
    callerNumber: digits(d.call.callerPhoneNumber),
    isNew: isNewOf(d.call, a?.isNewCustomer),
    counts: countsOf(a),
    persona:
      a?.personaName && a.personaVersion !== null
        ? { name: a.personaName, version: a.personaVersion }
        : null,
    handoff: d.call.handoff
      ? { status: d.call.handoff.status, reason: d.call.handoff.reason }
      : null,
    callbackAsked: a?.hasCallbackRequest ?? null,
    handoffAsked: a?.hasHandoffRequest ?? null,
    hasComplaint: a ? a.hasComplaint : null,
    complaints: toComplaints(a),
    utterances: utterances.map((u) => ({
      order: u.utteranceOrder,
      atSec: u.offsetSeconds,
      speaker: u.speaker,
      text: u.utteranceText,
    })),
    actions: actions.map((x) => ({
      order: x.eventOrder,
      atSec: x.offsetSeconds,
      kind: x.action,
      text: x.summaryText,
    })),
    results: results.map((x) => ({
      order: x.eventOrder,
      atSec: x.offsetSeconds,
      kind: x.action,
      orderSeq: x.orderSeq,
      question: x.questionText,
      unansweredQuestionSeq: x.unansweredQuestionSeq,
      reason: x.unansweredReason ?? null,
    })),
    aiActionCount: d.aiActionCount,
    recording: rec
      ? {
          recordingSeq: rec.recordingSeq,
          url: rec.url,
          expiresAt: rec.expiresAt,
          error: rec.playbackError,
        }
      : null,
  }
}
