// 07 페르소나 — 서버 응답(Swagger 11/02) → 화면 모양. React · HTTP를 모르는 순수 함수 (personaMap.test.ts)
// 규칙 (11/02 사용자 결정): 수정은 최신 버전(HEAD)에서만 · 지난 버전은 보기 + 시험 통화만 · 비교 = 마지막 적용 ↔ 수정 중
// '적용 중'(ACTIVE)은 서비스 전체에 하나 → 통화에 안 쓰는 페르소나의 기준은 '마지막으로 적용됐던 버전'(appliedAt이 있는 가장 큰 번호)
import { ymd } from '@/shared/lib/dateRange'

export type Speed = 'SLOW' | 'NORMAL' | 'FAST' // 발화 속도 3단계 칩 (서버는 숫자 · null = 기본)
export type WaitTime = 'SHORT' | 'NORMAL' | 'LONG' // 고객 말 끝을 기다리는 시간

/** 음성 설정 — 버전마다 따로. voice '' = AI 기본 음성(서버 null) */
export interface VoiceSettings {
  voice: string
  speed: Speed
  waitTime: WaitTime
}

/** 서버 버전 (PersonaVersionDto) — 쓰는 칸만 */
export interface PersonaVersionDto {
  aiPersonaVersionSeq: number
  version: number
  name: string
  promptText: string
  voiceId: string | null
  speakingRate: number | null
  turnWaitLevel: WaitTime
  status: 'ACTIVE' | 'PENDING' | 'INACTIVE'
  createdByAdminUserName?: string | null
  createdAt: string
  appliedAt: string | null
  applyErrorCode: string | null
}

/** 서버 페르소나 (PersonaDto) — 쓰는 칸만 */
export interface PersonaDto {
  aiPersonaSeq: number
  code: string
  headVersion: PersonaVersionDto // 최신 저장본 (= latestVersion)
  activeVersion: PersonaVersionDto | null // 지금 통화에 쓰는 버전 — 서비스 전체에서 한 페르소나만
  pendingVersion: PersonaVersionDto | null
}

/** 화면의 버전 상태: 저장됨(적용 안 한 최신) · 적용 대기 · 적용 중 · 마지막 적용(통화에 안 쓰는 페르소나의 기준) · 지난 버전 */
export type VersionStatus = 'SAVED' | 'PENDING' | 'ACTIVE' | 'APPLIED' | 'PAST'

export interface PersonaVersion {
  seq: number // aiPersonaVersionSeq — 적용 요청에 씀
  version: number
  status: VersionStatus
  isHead: boolean // 최신 저장본 — 수정 · 적용은 여기서만
  voiceOnly: boolean // 바로 앞 버전과 프롬프트는 같고 음성만 다름 ('음성 설정' 태그)
  changes: VersionChange // 바로 앞 버전과 무엇이 다른지 (요약 문장은 화면 층에서)
  author: string // 확인할 수 없는 옛 작성자는 ''
  savedAt: string // 'YYYY-MM-DD' (화면 시간대)
  prompt: string
  voice: VoiceSettings
}

/** 바로 앞 버전 대비 바뀐 것 — 첫 버전은 { first: true } */
export interface VersionChange {
  first: boolean
  prompt: boolean
  voice: [string, string] | null
  speed: [Speed, Speed] | null
  waitTime: [WaitTime, WaitTime] | null
}

export interface Persona {
  personaSeq: number
  code: string
  name: string // 최신 저장본의 이름
  voice: VoiceSettings // 마지막 적용 버전의 음성 (적용한 적 없으면 최신 저장본)
  inUse: boolean // 지금 통화에 쓰는 페르소나
  appliedVersion: number | null // 적용 중 또는 마지막 적용 버전. 한 번도 적용 안 했으면 null
  head: { version: number; seq: number } // 최신 저장본 — 수정의 expectedVersion · 적용 요청
  savedVersion: number | null // 저장만 하고 아직 적용 안 한 최신본 ('v5 저장됨')
  applyingVersion: number | null // 적용 대기 ('v5 적용 대기')
  applyError: string | null // 적용 대기 중 AI 반영 오류 코드 (대기는 유지됨)
}

/** 서버 숫자 속도 → 칩. null · 1 = 보통 */
export const toSpeed = (rate: number | null): Speed =>
  rate === null || rate === 1 ? 'NORMAL' : rate < 1 ? 'SLOW' : 'FAST'

const RATE = { SLOW: 0.85, FAST: 1.2 } as const // 칩 → 숫자 (11/02 결정: 3단계 칩 유지)
/** 칩 → 서버 숫자. 보통 = null(기본). AI가 숫자 속도를 지원 안 하면(range null) 언제나 null. 범위 밖이면 범위 끝으로 */
export function toRate(speed: Speed, range: { min: number; max: number } | null): number | null {
  if (speed === 'NORMAL' || !range) return null
  return Math.min(range.max, Math.max(range.min, RATE[speed]))
}

const toVoice = (v: PersonaVersionDto): VoiceSettings => ({
  voice: v.voiceId ?? '',
  speed: toSpeed(v.speakingRate),
  waitTime: v.turnWaitLevel,
})

/** 마지막으로 적용됐던 버전 번호 — 적용 중이면 그것, 아니면 appliedAt이 있는 가장 큰 번호 */
export function lastApplied(versions: PersonaVersionDto[]): number | null {
  const done = versions.filter((v) => v.status === 'ACTIVE' || v.appliedAt !== null)
  return done.length ? Math.max(...done.map((v) => v.version)) : null
}

/** 버전 기록 → 화면 버전 (높은 번호가 위). 서버 순서를 믿지 않고 정렬 */
export function toVersions(list: PersonaVersionDto[], headVersion: number): PersonaVersion[] {
  const sorted = [...list].sort((a, b) => b.version - a.version)
  const applied = lastApplied(sorted)
  return sorted.map((v, i) => {
    const prev = sorted[i + 1] // 바로 앞(낮은) 버전
    const voice = toVoice(v)
    const before = prev && toVoice(prev)
    const changes: VersionChange = {
      first: !prev,
      prompt: !!prev && prev.promptText !== v.promptText,
      voice: before && before.voice !== voice.voice ? [before.voice, voice.voice] : null,
      speed: before && before.speed !== voice.speed ? [before.speed, voice.speed] : null,
      waitTime:
        before && before.waitTime !== voice.waitTime ? [before.waitTime, voice.waitTime] : null,
    }
    const isHead = v.version === headVersion
    return {
      seq: v.aiPersonaVersionSeq,
      version: v.version,
      status:
        v.status !== 'INACTIVE'
          ? v.status
          : v.version === applied
            ? 'APPLIED'
            : isHead && (applied === null || v.version > applied)
              ? 'SAVED'
              : 'PAST',
      isHead,
      voiceOnly:
        !changes.first && !changes.prompt && !!(changes.voice || changes.speed || changes.waitTime),
      changes,
      author: v.createdByAdminUserName ?? '',
      savedAt: ymd(new Date(v.createdAt)),
      prompt: v.promptText,
      voice,
    }
  })
}

/** 페르소나 + 그 버전 기록 → 화면 페르소나 */
export function toPersona(p: PersonaDto, versions: PersonaVersionDto[]): Persona {
  const applied = lastApplied(versions)
  const base = versions.find((v) => v.version === applied) ?? p.headVersion
  const pending = p.pendingVersion?.version ?? null
  const head = p.headVersion.version
  return {
    personaSeq: p.aiPersonaSeq,
    code: p.code,
    name: p.headVersion.name,
    voice: toVoice(base),
    inUse: p.activeVersion !== null,
    appliedVersion: applied,
    head: { version: head, seq: p.headVersion.aiPersonaVersionSeq },
    savedVersion: head !== applied && head !== pending ? head : null,
    applyingVersion: pending,
    applyError: p.pendingVersion?.applyErrorCode ?? null,
  }
}
