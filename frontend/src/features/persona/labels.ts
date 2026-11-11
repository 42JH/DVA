// 페르소나 코드 → 화면 문구 (컨벤션 6.3: 코드는 api/, 문구는 labels.ts)
import { ApiError } from '@/shared/api/client'
import type { Tone } from '@/shared/ui'
import { PROMPT_KEYS, type PromptFields, type PromptKey } from './api/personaApi'

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

// 버전 표시 (11/11 — 저장 = 새 버전, [적용] 없음): 통화에 쓰는 버전 · AI 확인을 기다리는 버전
export const VERSION_BADGE = {
  ACTIVE: { label: '통화에 사용 중', tone: 'done' },
  PENDING: { label: '적용 대기', tone: 'wait' }, // AI가 확인하면 통화에 사용 중 (그동안 이전 버전이 계속 쓰임)
} satisfies Record<string, { label: string; tone: Tone }>

export const DRAFT_TAG = '작성 중' // 수정 화면에서 저장하기 전

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
