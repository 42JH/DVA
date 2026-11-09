// AI 미답변 공용 — 사유 문구 (미답변 사유 연동 11/04) · 화면 주소 · 경로 첫 칸 (11/05). 09 AI 미답변 · FAQ '답변 대기' · 06 처리 내용 · 통계가 같이 써서 shared (기능 폴더끼리 import 금지)
/** 서버 코드 그대로. null = 사유 없이 들어온 질문 · 연동 전에 쌓인 질문 (백엔드는 원인을 추정하지 않음) */
export type UnansweredReason = 'KB_NO_ANSWER' | 'KB_UNAVAILABLE'

/** 문구 (11/05 사용자): KB_NO_ANSWER = '유사한 질문 없음'(검색은 됐는데 맞는 FAQ가 없음 — FAQ 추가 대상)
 *  KB_UNAVAILABLE · null = '서버 에러'(검색이 안 됨 · 사유 없이 들어옴 — 둘 다 같은 칩. 예전 '지식 검색 장애' · '미분류')
 * bg = 칩 바탕 — 09 미답변 목록 · 06 처리 내용이 같은 칩 (04 상담 유형 칩과 같은 둥근 알약 · 높이 28 · 폭 76 이상 · 글자 16) */
export const reasonTag = (r: UnansweredReason | null): { label: string; bg: string } =>
  r === 'KB_NO_ANSWER'
    ? { label: '유사한 질문 없음', bg: 'bg-kind-faq' }
    : { label: '서버 에러', bg: 'bg-kind-cancel' }

/** AI 미답변 화면 주소 — from = 지금 화면 주소(경로 첫 칸 '이동 전 위치', 11/05 사용자) · call = 그 통화의 질문만 (06에서) */
export const unansweredTo = (from: string, call?: number) =>
  `/faqs/unanswered?${new URLSearchParams(call ? { call: String(call), from } : { from })}`

// 이동 전 화면 이름 — 그 화면 위에 보이던 제목 · 경로와 같은 말. 위에서부터 처음 맞는 것
const PAGE_NAMES: [RegExp, string][] = [
  [/^\/calls\/\d+/, '통화 상세'],
  [/^\/calls(?:[?#]|$)/, '통화'],
  [/^\/orders(?:[?#]|$)/, '주문'],
  [/^\/faqs(?:[?#]|$)/, 'FAQ'],
  [/^\/dashboard/, '통계'],
  [/^\/companies/, '기업관리'],
  [/^\/personas/, '페르소나 관리'],
  [/^\/admins/, '관리자 권한 관리'],
  [/^\/me(?:[?#]|$)/, '내 정보'],
]

/** 경로 첫 칸 = 미답변으로 오기 직전 화면 (주소의 from). 없거나 모르는 화면 · 바깥 주소('//…' — 주소는 누구나 고칠 수 있음)면 FAQ */
export function originOf(from: string | null | undefined): { label: string; to: string } {
  const inside = !!from && from.startsWith('/') && !from.startsWith('//')
  const name = inside ? PAGE_NAMES.find(([re]) => re.test(from))?.[1] : undefined
  return name && from ? { label: name, to: from } : { label: 'FAQ', to: '/faqs' }
}
