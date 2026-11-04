// AI 미답변 공용 — 사유 문구 (미답변 사유 연동 11/04) · 화면 주소 · 경로 첫 칸 (11/05). 09 AI 미답변 · 06 처리 내용 · 상단바 알림 · 통계가 같이 써서 shared (기능 폴더끼리 import 금지)
import type { TagKind } from '@/shared/ui'

/** 서버 코드 그대로. null = 사유 없이 들어온 질문 · 연동 전에 쌓인 질문 (백엔드는 원인을 추정하지 않음) */
export type UnansweredReason = 'KB_NO_ANSWER' | 'KB_UNAVAILABLE'

/** 문구는 AI팀 요청(11/04): 답변 근거 부족 = 검색은 됐는데 답할 근거가 없음(FAQ 추가 대상) · 지식 검색 장애 = 검색이 안 됨(FAQ에 답이 있었을 수도) · 미분류 = null */
export const reasonTag = (r: UnansweredReason | null): { label: string; kind: TagKind } =>
  r === 'KB_NO_ANSWER'
    ? { label: '답변 근거 부족', kind: 'gray' }
    : r === 'KB_UNAVAILABLE'
      ? { label: '지식 검색 장애', kind: 'red' }
      : { label: '미분류', kind: 'outline' }

/** AI 미답변 화면 주소 — from = 지금 화면 주소(경로 첫 칸 '이동 전 위치', 11/05 사용자) · call = 그 통화의 질문만 (06에서) */
export const unansweredTo = (from: string, call?: number) =>
  `/faqs/unanswered?${new URLSearchParams(call ? { call: String(call), from } : { from })}`

// 이동 전 화면 이름 — 그 화면 위에 보이던 제목 · 경로와 같은 말. 위에서부터 처음 맞는 것
const PAGE_NAMES: [RegExp, string][] = [
  [/^\/calls\/\d+/, '통화 상세'],
  [/^\/calls(?:[?#]|$)/, '통화'],
  [/^\/orders(?:[?#]|$)/, '주문'],
  [/^\/faqs\/new(?:[?#]|$)/, 'FAQ 작성'],
  [/^\/faqs\/\d+\/edit/, 'FAQ 수정'],
  [/^\/faqs\/\d+(?:[?#]|$)/, 'FAQ 상세'],
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

/** FAQ 작성(미답변에서 옴)의 경로 앞 두 칸 '[이동 전 위치] > AI 미답변'. back = 돌아갈 곳 — 미답변 목록 주소 */
export function unansweredCrumbs(back: string): { label: string; to: string }[] {
  const list = back.startsWith('/faqs/unanswered')
  const from = list ? new URL(back, 'http://x').searchParams.get('from') : back
  return [originOf(from), { label: 'AI 미답변', to: list ? back : unansweredTo(back) }]
}
