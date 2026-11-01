// 07 페르소나 관리 Model — 페르소나(AI 상담사 말투 · 목소리 묶음)와 버전(프롬프트 + 음성 설정 기록). React를 모르는 데이터 층
// 실서버 /api/personas (Swagger 11/02): 저장(PATCH) = 최신본(HEAD) 기준 새 INACTIVE 버전 · 적용(activate) = 최신본을 적용 대기(PENDING)
// → AI가 확인하면 ACTIVE(서비스 전체에 하나). 서버 모양 → 화면 모양은 personaMap.ts(순수 함수, 테스트)
// 백엔드 요청 중 (backend-todo 07): 적용 안 한 최신본 다시 저장 = 덮어쓰기 · [사용하기] = 마지막 적용 버전으로 적용
import { queryOptions } from '@tanstack/react-query'
import { api, type ApiItem } from '@/shared/api/client'
import { fetchAll } from '@/shared/api/paging'
import {
  toPersona,
  toRate,
  toVersions,
  type PersonaDto,
  type PersonaVersionDto,
  type VoiceSettings,
} from './personaMap'

export type {
  Persona,
  PersonaVersion,
  Speed,
  VersionChange,
  VersionStatus,
  VoiceSettings,
  WaitTime,
} from './personaMap'

export const DEFAULT_VOICE: VoiceSettings = { voice: '', speed: 'NORMAL', waitTime: 'NORMAL' } // '' = AI 기본 음성

/** AI가 실제 지원하는 음성 설정 (GET /api/ai/options). rateRange null = 숫자 속도 미지원 → 속도는 '보통'만 */
export interface AiOptions {
  voices: { id: string; label: string }[]
  rateRange: { min: number; max: number } | null
  waitTimes: VoiceSettings['waitTime'][]
}

export const personaQueries = {
  all: () => ['personas'] as const,
  list: () =>
    queryOptions({
      queryKey: [...personaQueries.all(), 'list'],
      queryFn: ({ signal }) => fetchPersonas(signal),
    }),
  versions: (personaSeq: number) =>
    queryOptions({
      queryKey: [...personaQueries.all(), personaSeq, 'versions'],
      queryFn: ({ signal }) => fetchVersions(personaSeq, signal),
    }),
  options: () =>
    queryOptions({
      queryKey: [...personaQueries.all(), 'options'],
      queryFn: ({ signal }) => fetchAiOptions(signal),
      staleTime: Infinity, // AI 지원값은 화면을 보는 동안 안 바뀜
    }),
}

const versionsOf = (personaSeq: number, signal?: AbortSignal) =>
  fetchAll<PersonaVersionDto>(`/personas/${personaSeq}/versions`, {}, signal)

/** 페르소나 목록 — '마지막 적용 버전'은 목록에 없어(ACTIVE는 전체에 하나) 페르소나마다 버전 기록을 받아 셈
 * shortcut: 페르소나 수만큼 요청 더 (지금 수 개) — 서버가 목록에 마지막 적용 버전을 넣어 주면 지울 것 */
export async function fetchPersonas(signal?: AbortSignal) {
  const list = await fetchAll<PersonaDto>('/personas', {}, signal)
  return Promise.all(list.map(async (p) => toPersona(p, await versionsOf(p.aiPersonaSeq, signal))))
}

/** 버전 기록 — 높은 번호가 위 */
export async function fetchVersions(personaSeq: number, signal?: AbortSignal) {
  const [persona, list] = await Promise.all([
    api.get<ApiItem<PersonaDto>>(`/personas/${personaSeq}`, { signal }),
    versionsOf(personaSeq, signal),
  ])
  return toVersions(list, persona.data.headVersion.version)
}

interface AiOptionsDto {
  voices: { id: string; label: string }[]
  speakingRate: { min: number | null; max: number | null } | null
  turnWaitLevels: VoiceSettings['waitTime'][]
}
export async function fetchAiOptions(signal?: AbortSignal): Promise<AiOptions> {
  const { data } = await api.get<ApiItem<AiOptionsDto>>('/ai/options', { signal })
  const r = data.speakingRate
  return {
    voices: data.voices,
    rateRange: r && r.min !== null && r.max !== null ? { min: r.min, max: r.max } : null,
    waitTimes: data.turnWaitLevels,
  }
}

/** 수정 저장 (PATCH /personas/{id}) — 최신본(expectedVersion) 기준 새 버전. 바뀐 칸만 보냄(생략 = 유지 → 서버의 정확한 숫자 속도를 안 건드림)
 * 지난 버전 기준 · 그새 누가 저장했으면 409. 저장된 버전 번호를 돌려줌 */
export async function savePromptVersion(
  personaSeq: number,
  input: {
    expectedVersion: number
    prompt: string | null // null = 안 바뀜
    voice: Partial<VoiceSettings> // 바뀐 것만
    rateRange: AiOptions['rateRange']
  },
): Promise<number> {
  const { voice, speed, waitTime } = input.voice
  const res = await api.patch<ApiItem<PersonaVersionDto>>(`/personas/${personaSeq}`, {
    body: {
      expectedVersion: input.expectedVersion,
      ...(input.prompt !== null && { promptText: input.prompt }),
      ...(voice !== undefined && { voiceId: voice || null }),
      ...(speed !== undefined && { speakingRate: toRate(speed, input.rateRange) }),
      ...(waitTime !== undefined && { turnWaitLevel: waitTime }),
    },
  })
  return res.data.version
}

/** 적용 요청 (POST /personas/{id}/activate) — 최신본만 받음(아니면 409). 202 = 적용 대기, 그동안 지금 버전이 계속 통화에 쓰임
 * 다른 대기는 서버가 취소. AI가 확인하면 ACTIVE → 화면은 대기 중에만 주기적으로 다시 받음 (usePersonaPage) */
export const requestApply = (
  personaSeq: number,
  head: { seq: number; version: number },
): Promise<void> =>
  api.post(`/personas/${personaSeq}/activate`, {
    body: { aiPersonaVersionSeq: head.seq, expectedVersion: head.version },
  })

/** 페르소나 추가 (POST /personas) — v1 저장(아직 적용 안 함). 코드는 바꿀 수 없고 겹치면 409. 만든 페르소나 번호를 돌려줌 */
export async function createPersona(input: {
  code: string
  name: string
  prompt: string
  voice: VoiceSettings
  rateRange: AiOptions['rateRange']
}): Promise<number> {
  const res = await api.post<ApiItem<{ aiPersonaSeq: number }>>('/personas', {
    body: {
      code: input.code,
      name: input.name,
      promptText: input.prompt,
      voiceId: input.voice.voice || null,
      speakingRate: toRate(input.voice.speed, input.rateRange),
      turnWaitLevel: input.voice.waitTime,
    },
  })
  return res.data.aiPersonaSeq
}

// ---------- 시험 통화 ----------
/** 시험 통화 한 줄 — AI 말 · 내 말 + 통화 시작부터 몇 초 */
export interface TestCallLine {
  atSec: number
  speaker: 'AI' | 'ME'
  text: string
}

/** 시험 통화 대본 — shortcut: 시험 통화 API(마이크 ↔ AI 실시간 음성)가 Swagger에 없어 정해진 대본이 시간에 맞춰 흐르는 가짜.
 * BE가 시험 통화 세션 API를 주면 이 함수 대신 실시간으로 받은 말을 쌓으면 됨 (훅 · 화면은 그대로) */
export function fakeTestCallScript(): TestCallLine[] {
  return [
    {
      atSec: 0,
      speaker: 'AI',
      text: '안녕하세요, 디버 택배 접수입니다. 보내는 분 성함을 말씀해 주세요.',
    },
    { atSec: 5, speaker: 'ME', text: '강도윤이요.' },
    { atSec: 8, speaker: 'AI', text: '강도윤 님, 전화번호를 말씀해 주세요.' },
    { atSec: 13, speaker: 'ME', text: '공일공 육육삼팔 이공사칠이요.' },
    { atSec: 19, speaker: 'AI', text: '공일공, 육육삼팔, 이공사칠 맞으실까요?' },
    { atSec: 24, speaker: 'ME', text: '네, 맞아요.' },
    { atSec: 26, speaker: 'AI', text: '받는 분 성함을 말씀해 주세요.' },
  ]
}
