// AI 미답변 사유 (미답변 사유 연동 11/04) — 09 AI 미답변 표 · 06 처리 내용이 같이 써서 shared (기능 폴더끼리 import 금지)
import type { TagKind } from '@/shared/ui'

/** 서버 코드 그대로. null = 사유 없이 들어온 질문 · 연동 전에 쌓인 질문 (백엔드는 원인을 추정하지 않음) */
export type UnansweredReason = 'KB_NO_ANSWER' | 'KB_UNAVAILABLE'

/** 근거 부족 = 검색은 됐는데 답할 근거가 없음(FAQ 추가 대상) · 검색 장애 = 검색이 안 됨(FAQ에 답이 있었을 수도) · 미분류 = null */
export const reasonTag = (r: UnansweredReason | null): { label: string; kind: TagKind } =>
  r === 'KB_NO_ANSWER'
    ? { label: '근거 부족', kind: 'gray' }
    : r === 'KB_UNAVAILABLE'
      ? { label: '검색 장애', kind: 'red' }
      : { label: '미분류', kind: 'outline' }
