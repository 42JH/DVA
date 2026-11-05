// 06 AI 동작 기록 글 정제 (11/05 사용자: 실서버 요약이 'ADDRESS_NOT_FOUND' · '기록: 1개 항목' · 'COLLECTING'처럼 날 것 그대로)
// AI 서버가 보내는 summaryText(ai/app/calls/results.py _summary · 통화 결과 전송)를 화면 말로 — 서버는 고치지 않음, 지난 통화에도 그대로 적용
// 순수 함수 · '@/' import 없음 — `npx tsx src/features/call/actionText.test.ts` 로 바로 확인
import type { AiAction } from './api/callDto'

/** 도구 실패 코드 → 화면 말 (develop-ai ToolOutcome · 확인 게이트 · 수거 일시 규칙에서 모음, 11/05) */
const FAIL_TEXT: Record<string, string> = {
  ADDRESS_NOT_FOUND: '주소를 찾지 못해 다시 물음',
  ADDRESS_GEO_MISSING: '주소 위치를 확인하지 못함',
  ADDRESS_AUTO_SELECTED: '주소 후보 중 하나를 골라 기록',
  DEST_NONE: '받는 곳 후보가 없어 다시 물음',
  DEST_TOO_MANY: '받는 곳 후보가 너무 많아 다시 물음',
  DEST_MANY: '받는 곳 후보가 여럿이라 고르게 함',
  PHONE_INVALID_DIGITS: '전화번호 자릿수가 맞지 않아 다시 물음',
  PICKUP_INVALID_FORMAT: '수거 일시를 알아듣지 못해 다시 물음',
  PICKUP_IN_PAST: '지난 시각이라 수거 일시를 다시 물음',
  PICKUP_TOO_SOON: '수거까지 시간이 모자라 다시 물음',
  PICKUP_TOO_FAR: '너무 먼 날짜라 수거 일시를 다시 물음',
  PICKUP_OUT_OF_HOURS: '수거 가능 시간이 아니라 다시 물음',
  ITEM_UNSPECIFIED: '물품 종류를 다시 물음',
  MISSING_ITEMS: '물품을 다시 물음',
  MISSING_ITEM_PRICE: '물품 가액을 다시 물음',
  MISSING_ADDRESS_DETAIL: '상세주소를 다시 물음',
  NOTHING_TO_RECORD: '기록할 내용이 없어 다시 물음',
  NOTHING_CHANGED: '바뀐 내용 없음',
  RESULT_SUPERSEDED: '그사이 바뀐 값이라 반영하지 않음',
  ORDER_SUBMITTED: '접수한 뒤라 바꾸지 않음',
  ORDER_NOT_FOUND_BY_NAME: '찾는 택배가 없어 다시 물음',
  ORDER_OUT_OF_RANGE: '고른 택배가 목록에 없음',
  CANCEL_LOCKED: '취소할 수 없는 상태',
  CANCEL_ALREADY: '이미 취소된 주문',
  CANCEL_OUTCOME_UNKNOWN: '취소 결과를 확인하지 못함',
  CALL_NOT_REGISTERED: '고객 확인 전이라 처리하지 못함',
  CUSTOMER_UNKNOWN: '고객을 확인하지 못함',
  KB_UNAVAILABLE: 'FAQ 검색 장애',
  KB_TIMEOUT: 'FAQ 검색 시간 초과',
  KB_NO_EVIDENCE: 'FAQ에 답이 없음',
  KB_LOW_SCORE: 'FAQ에 맞는 답이 없음',
  CONFIRM_UNCLEAR: '확인 대답이 분명하지 않아 다시 물음',
  CONFIRM_BEFORE_READBACK_END: '되읽기 전에 대답해 다시 확인',
  CONFIRM_SNAPSHOT_CHANGED: '내용이 바뀌어 다시 확인',
  DECISION_STALE: '지난 확인이라 다시 확인',
  FARE_UNKNOWN: '운임을 계산하지 못함',
  PAYMENT_UNKNOWN: '결제 방식을 확인하지 못함',
  NO_CONFIRMED_PARCEL: '확정된 택배가 없음',
  INCOMPLETE: '접수 정보가 덜 모임',
  TOOL_TIMEOUT: '응답 시간 초과',
  TOOL_ARGS_INVALID: '내용을 다시 확인함',
  TOOL_NOT_ALLOWED: '지금 할 수 없는 동작',
  INTERNAL_ERROR: '내부 오류',
  // 코드 없이 상태만 올 때
  needs_input: '다시 물음',
  needs_choice: '고르게 함',
  unavailable: '일시 장애',
  rejected: '처리하지 못함',
  unknown: '결과를 확인하지 못함',
}

/** '통화 결과 전송: {주문 상태}' — 주문 상태 8개(shared/order/orderDto)를 조금 더 자세히 (주문 화면 묶음 이름보다) */
const STATUS_TEXT: Record<string, string> = {
  COLLECTING: '미완료 주문',
  notPaid: '결제 대기',
  PAID: '결제 완료',
  SUBMITTING: '디버 접수 중',
  SUBMITTING_FAILED: '디버 접수 재시도 중',
  ACCEPTED: '디버 접수 완료',
  SUBMISSION_FAILED: '디버 접수 실패',
  CANCELLED: '주문 취소',
}

/** 요약 한 줄 → 화면 말. 모르는 모양은 그대로 (AI가 문구를 바꿔도 깨지지 않게) */
export function refineAction(text: string): string {
  const t = text.trim()
  let m = /^실패·재질문:\s*(\S+)$/.exec(t)
  if (m) {
    const code = m[1]
    return FAIL_TEXT[code] ?? (code.startsWith('MISSING_') ? '빠진 정보를 다시 물음' : '다시 물음')
  }
  m = /^기록:\s*(\d+)개 항목$/.exec(t)
  if (m) return `항목 ${m[1]}개 기록`
  m = /^통화 결과 전송:\s*(.+)$/.exec(t)
  if (m) return `주문 전송 · ${STATUS_TEXT[m[1]] ?? m[1]}`
  if (t === 'FAQ 근거 있음') return 'FAQ에서 답을 찾음'
  if (t === 'FAQ 근거 없음') return 'FAQ에 답이 없음'
  if (t === '등록 고객' || t === '미등록 고객' || t === '탈퇴 고객') return `고객 조회 · ${t}`
  return t
}

/** 화면 한 줄 = 동작 한 개 또는 연달아 나온 '기록'(칸 채우기) 여러 개를 합친 것 — 'n개 항목' 합계 */
export interface ActionGroup {
  head: AiAction // 시각 · 종류 · 누르면 갈 곳은 첫 동작 기준
  all: AiAction[] // 하이라이트는 이 중 하나라도 짚은 말이 불렀으면
  text: string
}

const recordCount = (a: AiAction) =>
  a.kind === 'FIELD_SAVED' ? Number(/^기록:\s*(\d+)개 항목$/.exec(a.text.trim())?.[1] ?? NaN) : NaN

export function groupActions(actions: AiAction[]): ActionGroup[] {
  const out: (ActionGroup & { n: number })[] = []
  for (const a of actions) {
    const n = recordCount(a)
    const last = out[out.length - 1]
    if (!Number.isNaN(n) && last && !Number.isNaN(last.n)) {
      last.all.push(a)
      last.n += n
      last.text = `항목 ${last.n}개 기록`
    } else out.push({ head: a, all: [a], text: refineAction(a.text), n })
  }
  return out.map(({ head, all, text }) => ({ head, all, text }))
}
