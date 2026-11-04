// 04 · 06 서버 DTO (연동 상세명세 10/31 §13: CallListItem · CallDetail · CallAnalysis · CallComplaint · Recording · Utterance · CallAction · CallProcessingResult)
// + 화면 모양으로 바꾸는 순수 변환. '@/'는 타입만 import — `npx tsx src/features/call/api/callDto.test.ts` 로 바로 돌리려고
import type { UnansweredReason } from '@/shared/lib/unansweredReason'

// ---------- 서버 DTO ----------
export type ResultDto = 'REGISTERED' | 'REGISTRATION_FAILED' | 'HANDOFF' | 'CANCELLED' | 'INQUIRY'
export type ComplaintType =
  'REPEATED_QUESTION' | 'SPEAKING_TOO_FAST' | 'RECOGNITION_FAILURE' | 'SLOW_RESPONSE' | 'AI_REFUSAL'
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

export interface CallComplaintDto {
  type: ComplaintType
  evidenceText: string
  offsetSeconds: number | null
  utteranceOrders: number[]
}
export interface CallAnalysisDto {
  result: ResultDto
  aiPersonaVersionSeq: number | null
  personaName: string | null
  personaVersion: number | null
  aiStartedAt: string
  aiEndedAt: string
  repeatQuestionCount: number | null
  hasComplaint: boolean | null
  complaints: CallComplaintDto[]
  analysedAt: string
}
export interface HandoffDto {
  handoffRequestSeq: number
  reason: string
  status: 'REQUESTED' | 'CONNECTED' | 'FAILED'
  assignedAdminUserSeq: number | null
  summaryText: string | null
  requestedAt: string
}
export interface CallDto {
  callSessionSeq: number
  customerName: string | null
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
  faqEntrySeq: number | null
  questionUtteranceOrder: number | null
  answerUtteranceOrder: number | null
}

// ---------- 화면 모양 ----------
/** 통화 결과 = 04와 같은 5개 (화면 코드는 그대로 두고 서버 값은 아래 OUTCOME_OF로) */
export type Outcome = 'HANDOFF' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'INQUIRY'

export interface CallRow {
  callSessionSeq: number
  startedAt: string | null
  customerName: string | null
  callerNumber: string // 숫자만. 모르면 ''
  outcome: Outcome | null // null = 분석 전
  complaint: { type: ComplaintType; reason: string } | null // 첫 불만 (04 열 하나)
  durationSec: number | null
}
export interface Complaint {
  type: ComplaintType
  reason: string
  offsetSeconds: number | null
  utteranceOrders: number[] // 스크립트에서 빨갛게 묶을 발화 순번 (빈 배열 = 모름)
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
export interface ResultBlock {
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
export interface CallDetail {
  callSessionSeq: number
  customerName: string | null
  outcome: Outcome | null
  startedAt: string | null
  durationSec: number | null
  callerNumber: string
  persona: { name: string; version: number } | null
  handoff: { status: HandoffDto['status']; reason: string } | null
  complaints: Complaint[]
  utterances: Utterance[]
  actions: AiAction[]
  results: ResultBlock[]
  aiActionCount: number
  recording: Recording | null // 첫 녹취 (url 있는 것 우선). 빈 배열(아직 연결 안 됨)이면 null
}

export const OUTCOME_OF: Record<ResultDto, Outcome> = {
  REGISTERED: 'SUCCESS',
  REGISTRATION_FAILED: 'FAILED',
  HANDOFF: 'HANDOFF',
  CANCELLED: 'CANCELLED',
  INQUIRY: 'INQUIRY',
}
export const RESULT_OF: Record<Outcome, ResultDto> = {
  SUCCESS: 'REGISTERED',
  FAILED: 'REGISTRATION_FAILED',
  HANDOFF: 'HANDOFF',
  CANCELLED: 'CANCELLED',
  INQUIRY: 'INQUIRY',
}

export const digits = (phone: string | null) => (phone ?? '').replace(/\D/g, '')

/** 통화 시간 = PBX 종료 − 시작 (초). 한쪽이라도 없으면 null */
export function durationSec(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt || !endedAt) return null
  return Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000))
}

export function toCallRow(d: CallListItemDto): CallRow {
  const c = d.analysis?.complaints[0]
  return {
    callSessionSeq: d.callSessionSeq,
    startedAt: d.startedAt,
    customerName: d.customerName,
    callerNumber: digits(d.callerPhoneNumber),
    outcome: d.analysis ? OUTCOME_OF[d.analysis.result] : null,
    complaint: c ? { type: c.type, reason: c.evidenceText } : null,
    durationSec: durationSec(d.startedAt, d.endedAt),
  }
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
    outcome: a ? OUTCOME_OF[a.result] : null,
    startedAt: d.call.startedAt,
    durationSec: durationSec(d.call.startedAt, d.call.endedAt),
    callerNumber: digits(d.call.callerPhoneNumber),
    persona:
      a?.personaName && a.personaVersion !== null
        ? { name: a.personaName, version: a.personaVersion }
        : null,
    handoff: d.call.handoff
      ? { status: d.call.handoff.status, reason: d.call.handoff.reason }
      : null,
    complaints: (a?.complaints ?? []).map((c) => ({
      type: c.type,
      reason: c.evidenceText,
      offsetSeconds: c.offsetSeconds,
      utteranceOrders: c.utteranceOrders,
    })),
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
