// 07 페르소나 — 서버 응답(develop-backend 11/02 초안 계약, docs/persona-head-management.md) → 화면 모양. React · HTTP를 모르는 순수 함수 (personaMap.test.ts)
// 규칙: 수정은 최신 버전에서만 · 적용 전까지 새 버전 없음 · 지난 버전은 보기 + 시험 통화만 · 비교 = 적용본 ↔ 수정 중
// 서버 칸 → 화면: draft(초안, 페르소나마다 1개) = 'v(HEAD+1) 저장됨' · headVersion = 적용본(통화에 안 쓰는 페르소나도) · activeVersion = 지금 통화에 쓰는 버전
// appliedAt은 'AI가 적용에 성공한 시각'이라 적용본을 찾는 기준이 아님 (백엔드 11/02 답)

export type Speed = 'SLOW' | 'NORMAL' | 'FAST' // 발화 속도 3단계 칩 (서버는 숫자 · null = 기본)
type WaitTime = 'SHORT' | 'NORMAL' | 'LONG' // 고객 말 끝을 기다리는 시간

/** 음성 설정 — 버전마다 따로. voice '' = AI 기본 음성(서버 null) */
export interface VoiceSettings {
  voice: string
  speed: Speed
  waitTime: WaitTime
}

// 프롬프트 여섯 칸 (백엔드 59948ac, 11/09) — 서버가 칸별로 저장하고 promptText는 합친 읽기 전용이라 안 씀
// 순서 = 화면 순서(보기 · 수정 · 비교). 제목 문구는 labels.ts
export const PROMPT_KEYS = [
  'role',
  'personality',
  'tone',
  'speedInstruction',
  'backchannel',
  'interruption',
] as const
export type PromptKey = (typeof PROMPT_KEYS)[number]
export type PromptFields = Record<PromptKey, string>

/** 서버 버전 (PersonaVersionDto) — 쓰는 칸만 */
export interface PersonaVersionDto extends PromptFields {
  promptText?: string // 여섯 칸을 서버가 합친 글 — AI가 통화에서 받는 글. 시나리오 시험을 시작할 때 창구에 보냄
  aiPersonaVersionSeq: number
  version: number
  name: string
  voiceId: string | null
  speakingRate: number | null
  turnWaitLevel: WaitTime
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE'
  createdByAdminUserName?: string | null
  createdAt: string
  appliedAt: string | null
  applyErrorCode: string | null
}

/** 서버 초안 (PersonaDraftDto) — 쓰는 칸만. 번호가 없음 (확정하면 HEAD + 1) */
export interface PersonaDraftDto extends PromptFields {
  draftRevision: string // 저장마다 바뀌는 UUID — 다음 저장 · 확정의 expectedDraftRevision
  baseVersion: number // 초안을 시작한 HEAD 번호
  name: string
  voiceId: string | null
  speakingRate: number | null
  turnWaitLevel: WaitTime
  updatedAt: string
}

/** 서버 페르소나 (PersonaDto) — 쓰는 칸만 */
export interface PersonaDto {
  aiPersonaSeq: number
  code: string
  headVersion: PersonaVersionDto // 마지막 확정 버전 = 적용본
  activeVersion: PersonaVersionDto | null // 지금 통화에 쓰는 버전 — 서비스 전체에서 한 페르소나만
  pendingVersion: PersonaVersionDto | null
  draft: PersonaDraftDto | null // 저장만 하고 적용 안 한 수정본
}

/** 화면의 버전 상태: 저장됨(초안 · 또는 확정만 되고 적용 안 된 HEAD) · 적용 대기 · 적용 중 · 마지막 적용(통화에 안 쓰는 페르소나의 적용본) · 지난 버전 */
type VersionStatus = 'SAVED' | 'PENDING' | 'ACTIVE' | 'APPLIED' | 'PAST'

export interface PersonaVersion {
  version: number
  name: string // 버전마다 이름이 있음 — 초안에서 바꾼 이름은 확정 전까지 여기에만
  status: VersionStatus
  isHead: boolean // 서버 HEAD(확정 버전 중 최신)
  isDraft: boolean // 초안 줄 — 번호는 화면이 붙인 HEAD + 1, 서버 버전 기록엔 없음
  author: string // 확인할 수 없는 옛 작성자는 ''
  promptText: string // 서버가 합친 글 (초안 줄은 '')
  savedAt: string // 서버 ISO 그대로 — 화면 형식은 fmtVersionTime (버전 기록은 분까지, 11/11)
  prompt: PromptFields
  voice: VoiceSettings
}

export interface Persona {
  personaSeq: number
  code: string
  name: string // HEAD의 이름
  voice: VoiceSettings // 적용본의 음성
  inUse: boolean // 지금 통화에 쓰는 페르소나
  appliedVersion: number // 적용본 — 통화 중이면 activeVersion, 아니면 HEAD
  head: { version: number; seq: number } // HEAD — 저장 · 확정의 expectedVersion, 적용 요청
  draftRevision: string | null // 초안이 있으면 그 UUID (저장 · 확정에 보냄)
  applyingVersion: number | null // 적용 대기 ('v5 적용 대기')
  applyError: string | null // 적용 대기 중 AI 반영 오류 코드 (대기는 유지됨)
}

/** 서버 숫자 속도 → 칩. null · 1 = 보통 */
export const toSpeed = (rate: number | null): Speed =>
  rate === null || rate === 1 ? 'NORMAL' : rate < 1 ? 'SLOW' : 'FAST'

const RATE = { SLOW: 0.85, FAST: 1.2 } as const // 칩 → 숫자 (3단계 칩 유지)
/** 칩 → 서버 숫자. 보통 = null(기본). 범위 밖이면 범위 끝으로
 * AI가 숫자 속도를 지원 안 하면(range null) 고른 값 그대로 보냄 → 서버가 422로 거절 (몰래 '보통'으로 바꿔 저장하지 않게, 11/02 사용자: 늘 세 칸) */
export function toRate(speed: Speed, range: { min: number; max: number } | null): number | null {
  if (speed === 'NORMAL') return null
  return range ? Math.min(range.max, Math.max(range.min, RATE[speed])) : RATE[speed]
}

// DTO에서 여섯 칸만 — 통째로 넘기면 다른 서버 칸까지 prompt에 섞임
const toPrompt = ({
  role,
  personality,
  tone,
  speedInstruction,
  backchannel,
  interruption,
}: PromptFields): PromptFields => ({
  role,
  personality,
  tone,
  speedInstruction,
  backchannel,
  interruption,
})

const toVoice = (v: PersonaVersionDto): VoiceSettings => ({
  voice: v.voiceId ?? '',
  speed: toSpeed(v.speakingRate),
  waitTime: v.turnWaitLevel,
})

/** 초안을 버전 기록 한 줄 모양으로 — 번호는 HEAD + 1 (확정하면 받을 번호) */
const draftRow = (d: PersonaDraftDto, headVersion: number): PersonaVersionDto => ({
  aiPersonaVersionSeq: 0, // 서버 버전이 아님 — 적용은 확정(POST versions)부터
  version: headVersion + 1,
  name: d.name,
  ...toPrompt(d),
  voiceId: d.voiceId,
  speakingRate: d.speakingRate,
  turnWaitLevel: d.turnWaitLevel,
  status: 'INACTIVE',
  createdByAdminUserName: null, // 초안은 저장자 번호만 줌
  createdAt: d.updatedAt,
  appliedAt: null,
  applyErrorCode: null,
})

/** 화면 상태 — 초안은 저장됨, 서버 상태가 있으면(통화에 사용 중 · 적용 대기) 그대로, 나머지는 지난 버전 · 적용본 */
const statusOf = (
  v: PersonaVersionDto,
  is: { draft: boolean; head: boolean },
  active: number | undefined, // 통화에 쓰는 버전 번호
): PersonaVersion['status'] => {
  if (is.draft) return 'SAVED'
  if (v.status !== 'INACTIVE') return v.status
  if (!is.head) return 'PAST'
  // 확정됐지만 적용 요청이 안 된 HEAD (확정 뒤 적용 요청이 실패한 경우) → [적용] 다시
  return active !== undefined && v.version > active ? 'SAVED' : 'APPLIED'
}

/** 버전 기록 (+ 초안이 있으면 맨 위 한 줄) → 화면 버전 (높은 번호가 위). 서버 순서를 믿지 않고 정렬 */
export function toVersions(
  list: PersonaVersionDto[],
  headVersion: number,
  draft: PersonaDraftDto | null,
): PersonaVersion[] {
  const draftDto = draft && draftRow(draft, headVersion)
  const sorted = [...list, ...(draftDto ? [draftDto] : [])].sort((a, b) => b.version - a.version)
  const active = list.find((v) => v.status === 'ACTIVE')?.version
  return sorted.map((v) => {
    const isDraft = v === draftDto
    const isHead = !isDraft && v.version === headVersion
    return {
      version: v.version,
      name: v.name,
      status: statusOf(v, { draft: isDraft, head: isHead }, active),
      isHead,
      isDraft,
      author: v.createdByAdminUserName ?? '',
      promptText: (v as { promptText?: string }).promptText ?? '',
      savedAt: v.createdAt,
      prompt: toPrompt(v),
      voice: toVoice(v),
    }
  })
}

/** 서버 페르소나 → 화면 페르소나 (버전 기록 없이 목록 한 번으로 — 적용본 = HEAD라서) */
export function toPersona(p: PersonaDto): Persona {
  const applied = p.activeVersion ?? p.headVersion // 통화 중이면 그 버전, 아니면 HEAD가 적용본 (백엔드 11/02)
  const pending = p.pendingVersion?.version ?? null
  const head = p.headVersion.version
  return {
    personaSeq: p.aiPersonaSeq,
    code: p.code,
    name: p.headVersion.name,
    voice: toVoice(applied),
    inUse: p.activeVersion !== null,
    appliedVersion: applied.version,
    head: { version: head, seq: p.headVersion.aiPersonaVersionSeq },
    draftRevision: p.draft?.draftRevision ?? null,
    applyingVersion: pending,
    applyError: p.pendingVersion?.applyErrorCode ?? null,
  }
}
