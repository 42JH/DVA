// AI 미답변 공용 — 사유 문구 (미답변 사유 연동 11/04) . 09 AI 미답변 · FAQ '답변 대기' · 06 처리 내용 · 통계가 같이 써서 shared (기능 폴더끼리 import 금지)
/** 서버 코드 그대로. null = 사유 없이 들어온 질문 · 연동 전에 쌓인 질문 (백엔드는 원인을 추정하지 않음) */
export type UnansweredReason = 'KB_NO_ANSWER' | 'KB_UNAVAILABLE'

/** 문구 (11/05 사용자): KB_NO_ANSWER = '유사한 질문 없음'(검색은 됐는데 맞는 FAQ가 없음 — FAQ 추가 대상)
 *  KB_UNAVAILABLE · null = '서버 에러'(검색이 안 됨 · 사유 없이 들어옴 — 둘 다 같은 칩. 예전 '지식 검색 장애' · '미분류')
 * bg = 칩 바탕 — 09 미답변 목록 · 06 처리 내용이 같은 칩 (04 상담 유형 칩과 같은 둥근 알약 · 높이 28 · 폭 76 이상 · 글자 16) */
export const reasonTag = (r: UnansweredReason | null): { label: string; bg: string } =>
  r === 'KB_NO_ANSWER'
    ? { label: '유사한 질문 없음', bg: 'bg-kind-faq' }
    : { label: '서버 에러', bg: 'bg-kind-cancel' }
