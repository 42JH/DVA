// 페르소나 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import { ApiError } from '@/shared/api/client'
import type { TagKind } from '@/shared/ui'
import {
  PROMPT_KEYS,
  type PromptFields,
  type PromptKey,
  type Speed,
  type VersionStatus,
  type WaitTime,
} from './api/personaApi'

// 프롬프트 칸 제목 — 서버가 합친 글(persona-prompt.ts)과 같은 말. 사용자가 못 고치는 글 (11/10)
export const PROMPT_LABEL: Record<PromptKey, string> = {
  role: '역할',
  personality: '성격',
  tone: '톤',
  speedInstruction: '속도',
  backchannel: '맞장구',
  interruption: '끼어들기',
}
// 서버 글처럼 톤 · 속도는 '발화 스타일' 아래 — 이 칸 앞에 묶음 제목을 한 번, 두 칸은 한 단계 아래 제목
const PROMPT_GROUP: Partial<Record<PromptKey, string>> = { tone: '발화 스타일' }
const UNDER_GROUP: PromptKey[] = ['tone', 'speedInstruction']

/** 화면 순서대로 칸 제목 · 묶음 제목 — 보기 · 수정 · 비교가 같이 씀 */
export const PROMPT_SECTIONS = PROMPT_KEYS.map((key) => ({
  key,
  title: PROMPT_LABEL[key],
  group: PROMPT_GROUP[key] ?? null,
  sub: UNDER_GROUP.includes(key),
}))

/** 빈칸 안내 '톤 · 속도 칸이 비어 있습니다' — 서버가 공백뿐인 칸을 거절해서 저장 전에 막음. 다 채웠으면 null */
export function emptyPromptNotice(p: PromptFields): string | null {
  const empty = PROMPT_SECTIONS.filter((s) => p[s.key].trim() === '').map((s) => s.title)
  return empty.length ? `${empty.join(' · ')} 칸이 비어 있습니다` : null
}

export const SPEED_LABEL: Record<Speed, string> = {
  SLOW: '속도 느리게',
  NORMAL: '속도 보통',
  FAST: '속도 빠르게',
}

export const WAIT_LABEL: Record<WaitTime, string> = {
  SHORT: '기다리기 짧게',
  NORMAL: '기다리기 보통',
  LONG: '기다리기 길게',
}

// 버전 태그 (와이어프레임 07 버전 히스토리): 저장됨(미적용) = 회색 선, 적용 중 = 파랑, 마지막 적용 = 회색. 지난 버전은 태그 없음
// '작성 중'은 수정 화면의 저장 전 상태라 여기 없음 (DRAFT_TAG)
export const VERSION_TAG: Record<VersionStatus, { label: string; kind: TagKind } | null> = {
  SAVED: { label: '저장됨', kind: 'outline' },
  PENDING: { label: '적용 대기', kind: 'live' }, // AI가 확인하면 적용 중 (그동안 지금 버전이 계속 쓰임)
  ACTIVE: { label: '적용 중', kind: 'blue' },
  APPLIED: { label: '마지막 적용', kind: 'gray' }, // 통화에 안 쓰는 페르소나의 기준 버전 (11/02)
  PAST: null,
}

export const DRAFT_TAG = '작성 중' // 수정 화면에서 저장하기 전 ('v8 · 작성 중')

// 음성 세부 조절 칩 (와이어프레임 07_음성세부조절 순서 그대로)
export const SPEED_CHOICE: Record<Speed, string> = {
  SLOW: '느리게',
  NORMAL: '보통',
  FAST: '빠르게',
}
export const WAIT_CHOICE: Record<WaitTime, string> = { SHORT: '짧게', NORMAL: '보통', LONG: '길게' }

export const DEFAULT_VOICE_LABEL = '기본 음성' // 서버 voiceId null (목소리 '' )

const SETTING_LABEL: Record<string, string> = {
  voiceId: '목소리',
  speakingRate: '발화 속도',
  turnWaitLevel: '말 끝 기다리기',
}
/** 서버 422 'AI가 지원하지 않는 설정'(details: field · reason 'unsupported') → 어느 칸인지 문구. 그 오류가 아니면 null */
export function unsupportedText(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.status !== 422) return null
  const fields = e.details
    .filter((d) => d.reason === 'unsupported')
    .map((d) => SETTING_LABEL[d.field] ?? d.field)
  return fields.length
    ? `AI가 아직 지원하지 않는 설정입니다: ${fields.join(' · ')}. 다른 값을 골라 주세요.`
    : null
}
