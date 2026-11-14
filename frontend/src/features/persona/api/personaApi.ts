// 07 페르소나 관리 Model — 페르소나(AI 상담사 말투 · 목소리 묶음)와 버전(프롬프트 + 음성 설정 기록). React를 모르는 데이터 층
// 실서버 /api/personas (develop-backend 11/02 초안 계약): 초안(PATCH) · 확정(POST versions → 새 HEAD) · 적용 요청(activate → PENDING → ACTIVE, 서비스 전체에 하나)
// 11/11: [저장] = 초안 + 바로 확정(saveVersion), [통화에 사용하기] = 적용 요청(requestApply). [적용] 버튼 없음
// 서버 모양 → 화면 모양은 personaMap.ts(순수 함수, 테스트). 초안 삭제는 하지 않음. 지난 버전 [이 버전 다시 쓰기] = 그 내용을 saveVersion으로 (11/11)
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import {
  toPersona,
  toRate,
  toVersions,
  type PersonaDraftDto,
  type PersonaDto,
  type PersonaVersionDto,
  type PromptFields,
  type VoiceSettings,
} from './personaMap'
export { PROMPT_KEYS } from './personaMap'

export type { PersonaVersion, PromptFields, PromptKey, VoiceSettings } from './personaMap'

export const DEFAULT_VOICE: VoiceSettings = { voice: '', speed: 'NORMAL', waitTime: 'NORMAL' } // '' = AI 기본 음성

/** AI가 실제 지원하는 음성 설정 (GET /api/ai/options). rateRange null = 숫자 속도 미지원 → 속도는 '보통'만 */
interface AiOptions {
  voices: { id: string; label: string }[]
  rateRange: { min: number; max: number } | null
}

// 한 화면이 뜨는 동안 늦게 붙는 부품(띠 · 표)이 방금 받은 것을 또 부르지 않게 — 저장 · 반영 뒤에는 invalidate로 바로 다시 받음
const JUST_FETCHED_MS = 5_000

export const personaQueries = {
  all: () => ['personas'] as const,
  list: () =>
    queryOptions({
      queryKey: [...personaQueries.all(), 'list'],
      queryFn: ({ signal }) => fetchPersonas(signal),
      staleTime: JUST_FETCHED_MS,
    }),
  versions: (personaSeq: number) =>
    queryOptions({
      queryKey: [...personaQueries.all(), personaSeq, 'versions'],
      queryFn: ({ signal }) => fetchVersions(personaSeq, signal),
      staleTime: JUST_FETCHED_MS,
    }),
  options: () =>
    queryOptions({
      queryKey: [...personaQueries.all(), 'options'],
      queryFn: ({ signal }) => fetchAiOptions(signal),
      staleTime: Infinity, // AI 지원값은 화면을 보는 동안 안 바뀜
    }),
}

/** 페르소나 목록 — 적용본(HEAD) · 초안이 목록에 같이 옴 */
async function fetchPersonas(signal?: AbortSignal) {
  return (await fetchAll<PersonaDto>('/personas', {}, signal)).map(toPersona)
}

/** 버전 기록 + 초안(있으면 맨 위 'v(HEAD+1) 저장됨') — 높은 번호가 위. 버전 기록 API엔 초안이 없어 상세에서 받음 */
async function fetchVersions(personaSeq: number, signal?: AbortSignal) {
  const [persona, list] = await Promise.all([
    api.get<ApiItem<PersonaDto>>(`/personas/${personaSeq}`, { signal }),
    fetchAll<PersonaVersionDto>(`/personas/${personaSeq}/versions`, {}, signal),
  ])
  return toVersions(list, persona.data.headVersion.version, persona.data.draft)
}

interface AiOptionsDto {
  voices: { id: string; label: string }[]
  speakingRate: { min: number | null; max: number | null } | null
  turnWaitLevels: VoiceSettings['waitTime'][]
}
async function fetchAiOptions(signal?: AbortSignal): Promise<AiOptions> {
  const { data } = await api.get<ApiItem<AiOptionsDto>>('/ai/options', { signal })
  const r = data.speakingRate
  return {
    voices: data.voices,
    rateRange: r && r.min !== null && r.max !== null ? { min: r.min, max: r.max } : null,
  }
}

/** 초안 저장은 됐는데 새 버전 확정만 실패 — 내용은 초안에 남아 있음. 다시 받은 뒤 [저장]하면 확정만 다시 감 (usePromptEditor) */
export class ConfirmError extends Error {}

/** 수정 저장 (11/11 — 저장 = 바로 새 버전, [적용] 없음): 초안 덮어쓰기(PATCH /personas/{id}) → 그 초안을 확정(POST versions → 새 HEAD)
 * 통화엔 안 씀 — 통화는 [통화에 사용하기](activate)로만. 바뀐 칸만 보냄(생략 = 유지 → 서버의 정확한 숫자 속도를 안 건드림)
 * expectedDraftRevision: 초안이 없으면 null(생략 불가). 그새 누가 저장 · 확정했으면 409 */
export async function saveVersion(
  personaSeq: number,
  input: {
    expectedVersion: number // HEAD 번호
    expectedDraftRevision: string | null
    name?: string // 바뀌었을 때만
    prompt: Partial<PromptFields> // 바뀐 칸만 (서버는 생략한 칸을 유지)
    voice: Partial<VoiceSettings> // 바뀐 것만
    rateRange: AiOptions['rateRange']
  },
): Promise<void> {
  const { voice, speed, waitTime } = input.voice
  const changed = {
    ...(input.name !== undefined && { name: input.name }),
    ...input.prompt,
    ...(voice !== undefined && { voiceId: voice || null }),
    ...(speed !== undefined && { speakingRate: toRate(speed, input.rateRange) }),
    ...(waitTime !== undefined && { turnWaitLevel: waitTime }),
  }
  // 바뀐 칸이 없으면(남아 있던 초안 · 확정만 실패한 뒤 다시 저장) PATCH 없이 그 초안을 확정 — 서버는 빈 PATCH를 400으로 거절
  const revision =
    Object.keys(changed).length === 0 && input.expectedDraftRevision
      ? input.expectedDraftRevision
      : (
          await api.patch<ApiItem<PersonaDraftDto>>(`/personas/${personaSeq}`, {
            body: {
              expectedVersion: input.expectedVersion,
              expectedDraftRevision: input.expectedDraftRevision,
              ...changed,
            },
          })
        ).data.draftRevision
  try {
    await api.post(`/personas/${personaSeq}/versions`, {
      body: { expectedVersion: input.expectedVersion, expectedDraftRevision: revision },
    })
  } catch {
    throw new ConfirmError()
  }
}

/** 적용 요청 (POST /personas/{id}/activate) — HEAD만 받음(아니면 409). 202 = 적용 대기, 그동안 지금 버전이 계속 통화에 쓰임
 * 다른 대기는 서버가 취소. AI가 확인하면 ACTIVE → 화면은 대기 중에만 주기적으로 다시 받음 (usePersonaPage) */
export const requestApply = (
  personaSeq: number,
  head: { seq: number; version: number },
): Promise<void> =>
  api.post(`/personas/${personaSeq}/activate`, {
    body: { aiPersonaVersionSeq: head.seq, expectedVersion: head.version },
  })

/** 페르소나 삭제 (DELETE /personas, body { aiPersonaSeqs }) — 분류 번호 1~100개를 한꺼번에, 하나라도 실패하면 전부 안 지워짐(204 = 전체 성공)
 * 소프트 삭제: 소속 버전 · 초안 포함. ACTIVE 버전이 하나라도 있으면 409, 없거나 이미 지운 분류가 끼면 404. 화면은 한 건씩만 보냄 */
export const deletePersona = (personaSeq: number): Promise<void> =>
  api.delete('/personas', { body: { aiPersonaSeqs: [personaSeq] } })

/** 페르소나 추가 (POST /personas) — v1 저장(아직 적용 안 함). 코드는 바꿀 수 없고 겹치면 409. 만든 페르소나 번호를 돌려줌 */
export async function createPersona(input: {
  code: string
  name: string
  prompt: PromptFields // 서버는 여섯 칸 모두 필수
  voice: VoiceSettings
  rateRange: AiOptions['rateRange']
}): Promise<number> {
  const body = {
    name: input.name,
    ...input.prompt,
    voiceId: input.voice.voice || null,
    speakingRate: toRate(input.voice.speed, input.rateRange),
    turnWaitLevel: input.voice.waitTime,
  }
  const res = await api.post<ApiItem<{ aiPersonaSeq: number }>>('/personas', {
    body: { code: input.code, ...body },
  })
  return res.data.aiPersonaSeq
}
