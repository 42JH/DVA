// 07 페르소나 관리 Model — 페르소나(AI 상담사 말투 · 목소리 묶음)와 버전(시스템 프롬프트 + 음성 설정 기록). React를 모르는 데이터 층
// 지금은 네트워크 없이 메모리 가짜 데이터. Swagger(10/31)의 /api/personas 규칙을 흉내: 저장 = 새 버전(INACTIVE), [적용] = activate →
// PENDING(적용 대기, 서비스 전체에 하나) → AI가 확인하면 ACTIVE. 명세에 맞춰 연결할 때 함수 몸통만 바꾸면 됨
// 버전 날짜 · 번호는 02 대시보드 '버전별 기록' 가짜(v6 10.02 · v5 09.17 · v4 09.01)와 같게
import { queryOptions } from '@tanstack/react-query'
import { ApiError } from '@/shared/api/client'

export type Speed = 'SLOW' | 'NORMAL' | 'FAST' // 발화 속도
export type WaitTime = 'SHORT' | 'NORMAL' | 'LONG' // 고객 말 끝을 기다리는 시간

/** 음성 설정 — 버전마다 따로 (프롬프트와 함께 저장, 음성만 바꾼 버전 = '음성 설정' 태그) */
export interface VoiceSettings {
  voice: string // TTS 목소리 이름 'marin'
  speed: Speed
  waitTime: WaitTime
}

/** 고를 수 있는 목소리 — shortcut: 가짜 목록. 실제 목록은 `GET /api/ai/options`의 voices */
export const VOICES = ['marin', 'cedar', 'coral', 'sage'] as const
export const DEFAULT_VOICE: VoiceSettings = { voice: 'marin', speed: 'NORMAL', waitTime: 'NORMAL' }

export interface Persona {
  personaSeq: number
  code: string // 바꿀 수 없는 고유 코드 'parcel-fast'
  name: string // '빠른 접수형'
  voice: VoiceSettings // 적용 버전의 음성 (없으면 최신 버전) — 목록 칸 'marin · 속도 보통'
  inUse: boolean // 지금 통화에 쓰는 페르소나 (서비스 전체에 하나)
  activeVersion: number | null // 적용 버전. 한 번도 적용 안 한 새 페르소나는 null
  savedVersion: number | null // 저장됐지만 아직 적용 안 한 최신 버전 ('v7 저장됨')
  applyingVersion: number | null // 적용 대기 중인 버전 ('적용 대기') — 서비스 전체에 하나
}

/** 서버에 있는 버전의 상태: 저장됨(아직 적용 안 함) · 적용 대기 · 적용 중 · 지난 버전
 * '작성 중'은 서버에 없음 — 수정 화면에서 저장하기 전 상태일 뿐 (10/31 결정)
 * (Swagger: INACTIVE · PENDING · ACTIVE — 저장됨 · 지난 버전은 둘 다 INACTIVE, 적용 버전보다 새것이면 저장됨) */
export type VersionStatus = 'SAVED' | 'PENDING' | 'ACTIVE' | 'PAST'

export interface PersonaVersion {
  version: number
  status: VersionStatus
  voiceOnly: boolean // 프롬프트는 그대로, 음성 설정만 바꾼 버전 ('음성 설정' 태그)
  summary: string // 무엇을 바꿨는지 한 줄
  author: string
  savedAt: string // 'YYYY-MM-DD'
  basedOn: number | null // 어느 버전에서 시작해 고쳤는지 ('v6에서 시작'). 처음 만든 버전은 null
  prompt: string
  voice: VoiceSettings
}

export const personaQueries = {
  all: () => ['personas'] as const,
  list: () =>
    queryOptions({
      queryKey: [...personaQueries.all(), 'list'],
      queryFn: fetchPersonas,
    }),
  versions: (personaSeq: number) =>
    queryOptions({
      queryKey: [...personaQueries.all(), personaSeq, 'versions'],
      queryFn: () => fetchVersions(personaSeq),
    }),
}

const wait = () => new Promise((r) => setTimeout(r, 200)) // 가짜 응답 지연 ('불러오는 중' 확인용)
const today = () => new Date().toLocaleDateString('sv-SE') // 'YYYY-MM-DD' (화면 시간대)

export async function fetchPersonas(): Promise<Persona[]> {
  await wait()
  return PERSONAS.map((p) => ({ ...p, voice: { ...p.voice } }))
}

/** 버전 기록 — 최신부터 */
export async function fetchVersions(personaSeq: number): Promise<PersonaVersion[]> {
  await wait()
  return (VERSIONS[personaSeq] ?? []).map((x) => ({ ...x, voice: { ...x.voice } }))
}

/** 저장됨 · 적용 대기 표시값 다시 셈 (적용 버전 = 그 페르소나의 ACTIVE) */
function refresh(p: Persona) {
  const list = VERSIONS[p.personaSeq] ?? []
  const saved = list.filter((x) => x.status === 'SAVED')
  p.savedVersion = saved.length ? Math.max(...saved.map((x) => x.version)) : null
  p.applyingVersion = list.find((x) => x.status === 'PENDING')?.version ?? null
}

/** 수정한 프롬프트 · 음성 설정을 새 버전으로 저장 — 저장할 때마다 항상 '가장 큰 번호 + 1' (덮어쓰지 않음, 10/31 결정). 저장된 번호를 돌려줌
 * 저장 = '저장됨'(아직 통화엔 안 씀, Swagger PATCH → INACTIVE). 적용은 따로. 저장 전 '작성 중'은 화면에만 있고 여기로 오지 않음 */
export async function savePromptVersion(
  personaSeq: number,
  input: {
    prompt: string
    voice: VoiceSettings
    basedOn: number
    author: string
    summary: string
  },
): Promise<number> {
  await wait()
  const persona = PERSONAS.find((p) => p.personaSeq === personaSeq)
  const list = VERSIONS[personaSeq]
  if (!persona || !list) throw new Error('페르소나를 찾을 수 없습니다.')
  const version = Math.max(...list.map((x) => x.version)) + 1
  const base = list.find((x) => x.version === input.basedOn)
  list.unshift(
    v(version, 'SAVED', input.summary, input.author, today(), input.prompt, {
      basedOn: input.basedOn,
      voice: { ...input.voice },
      voiceOnly: base?.prompt === input.prompt, // 프롬프트는 그대로, 음성만 바뀜 → '음성 설정' 태그
    }),
  )
  refresh(persona)
  return version
}

const AI_CONFIRM_MS = 4000 // 가짜 AI가 적용을 확인하기까지 (실제는 진행 중인 통화가 0건이 될 때)
const beforePending = new Map<string, VersionStatus>() // 대기가 취소되면 원래 상태로 (저장됨 · 지난 버전)

/** 적용 요청 (Swagger `POST /api/personas/{id}/activate`) — 이 버전을 '적용 대기'로. 지난 버전도 다시 적용 가능(복원)
 * 다른 페르소나의 [사용하기]도 같은 요청. 적용 대기는 서비스 전체에 하나 → 다른 대기는 취소
 * 그동안 지금 적용 중인 버전이 계속 통화에 쓰이고, AI가 확인하면 '적용 중' + 통화에 쓰는 페르소나도 바뀜
 * shortcut: AI 확인을 4초 뒤 자동으로 흉내. 실제는 서버 상태가 바뀌므로 화면은 대기 중에만 주기적으로 다시 받음 (usePersonaPage) */
export async function requestApply(personaSeq: number, version: number): Promise<void> {
  await wait()
  const persona = PERSONAS.find((p) => p.personaSeq === personaSeq)
  const target = VERSIONS[personaSeq]?.find((x) => x.version === version)
  if (!persona || !target) throw new Error('버전을 찾을 수 없습니다.')
  if (target.status === 'ACTIVE' && persona.inUse) return // 이미 통화에 쓰는 그 버전 (다른 페르소나의 적용 버전은 [사용하기]로 요청 가능)
  for (const p of PERSONAS)
    for (const x of VERSIONS[p.personaSeq] ?? [])
      if (x.status === 'PENDING') {
        x.status = beforePending.get(`${p.personaSeq}-${x.version}`) ?? 'SAVED'
        refresh(p)
      }
  beforePending.set(`${personaSeq}-${version}`, target.status)
  target.status = 'PENDING'
  refresh(persona)
  setTimeout(() => confirmApply(personaSeq, version), AI_CONFIRM_MS)
}

/** (가짜 AI) 적용 확인 — 아직 그 버전이 대기 중일 때만 */
function confirmApply(personaSeq: number, version: number) {
  const persona = PERSONAS.find((p) => p.personaSeq === personaSeq)
  const list = VERSIONS[personaSeq]
  const target = list?.find((x) => x.version === version)
  if (!persona || !list || target?.status !== 'PENDING') return
  for (const x of list) if (x.status === 'ACTIVE') x.status = 'PAST'
  target.status = 'ACTIVE'
  persona.activeVersion = version
  persona.voice = { ...target.voice }
  for (const p of PERSONAS) p.inUse = p.personaSeq === personaSeq
  refresh(persona)
}

/** 페르소나 추가 (Swagger `POST /api/personas`) — 프롬프트 · 음성으로 v1을 저장(아직 적용 안 함). 코드는 바꿀 수 없고 겹치면 안 됨 */
export async function createPersona(input: {
  code: string
  name: string
  prompt: string
  voice: VoiceSettings
  author: string
}): Promise<number> {
  await wait()
  if (PERSONAS.some((p) => p.code === input.code))
    throw new ApiError(409, 'DUPLICATE_CODE', '이미 쓰는 코드입니다.', [
      { field: 'code', reason: '이미 쓰는 코드입니다. 다른 코드를 적어 주세요.' },
    ])
  const personaSeq = Math.max(...PERSONAS.map((p) => p.personaSeq)) + 1
  VERSIONS[personaSeq] = [
    v(1, 'SAVED', '처음 만듦', input.author, today(), input.prompt, { voice: { ...input.voice } }),
  ]
  PERSONAS.push({
    personaSeq,
    code: input.code,
    name: input.name,
    voice: { ...input.voice },
    inUse: false,
    activeVersion: null,
    savedVersion: 1,
    applyingVersion: null,
  })
  return personaSeq
}

// ---------- 가짜 데이터 = 와이어프레임 07 ----------
const voice = (name: string, speed: Speed, waitTime: WaitTime): VoiceSettings => ({
  voice: name,
  speed,
  waitTime,
})

const PERSONAS: Persona[] = [
  {
    personaSeq: 1,
    code: 'parcel-fast',
    name: '빠른 접수형',
    voice: voice('marin', 'NORMAL', 'NORMAL'),
    inUse: true,
    activeVersion: 6,
    savedVersion: 7,
    applyingVersion: null,
  },
  {
    personaSeq: 2,
    code: 'parcel-kind',
    name: '친절 안내형',
    voice: voice('cedar', 'SLOW', 'LONG'),
    inUse: false,
    activeVersion: 3,
    savedVersion: null,
    applyingVersion: null,
  },
]

// 프롬프트 조각 — 버전마다 조금씩 다름 (v6 → v7: 복창을 한 번에, 전화번호 끊어 복창 추가)
// v7 = 저장됐지만 아직 적용 안 한 버전 (디자인의 '작성 중 v7'은 저장 전 화면 상태라 서버 가짜에선 '저장됨')
const ROLE = '# 역할\n너는 디버 택배 전화 접수 AI다. 짧고 또렷하게 말한다.'
const steps = (readBack: string) =>
  `# 접수 순서\n1. 보내는 분 이름과 전화번호를 받는다.\n2. 받는 분 이름, 전화번호, 주소를 받는다.\n3. 물품 종류와 박스 크기를 묻는다.\n4. 보내기 전에 받은 내용을 ${readBack} 복창한다.`
const ASK = '# 되묻기\n- 잘 들리지 않은 항목만 다시 묻는다.\n- 확인된 항목은 다시 묻지 않는다.'
const PHONE = '- 전화번호는 세 자리, 네 자리, 네 자리로 끊어 복창한다.'
const ADDRESS =
  '# 주소 확인\n- 검색 결과가 1건이면 다시 묻지 않고 확정한다.\n- 여러 건이면 동 이름으로 한 번만 좁혀 묻는다.\n- 상세주소는 고객이 말한 그대로 받는다.'
// v6 되묻기는 '확인된 항목도 한 번 더 확인' → v7에서 '다시 묻지 않는다' + 전화번호 줄 (디자인 07 버전 비교: 빠진 줄 2 · 더한 줄 3)
const ASK_V6 = '# 되묻기\n- 잘 들리지 않은 항목만 다시 묻는다.\n- 확인된 항목도 한 번 더 확인한다.'
const V7 = [ROLE, steps('한 번에'), `${ASK}\n${PHONE}`, ADDRESS].join('\n\n')
const V6 = [ROLE, steps('항목마다'), ASK_V6, ADDRESS].join('\n\n')
const V3 = [ROLE, steps('항목마다'), ASK_V6].join('\n\n')

const v = (
  version: number,
  status: VersionStatus,
  summary: string,
  author: string,
  savedAt: string,
  prompt: string,
  extra: Partial<PersonaVersion> = {},
): PersonaVersion => ({
  version,
  status,
  voiceOnly: false,
  summary,
  author,
  savedAt,
  basedOn: null,
  prompt,
  voice: voice('marin', 'NORMAL', 'SHORT'), // 빠른 접수형 v4 이전 기본
  ...extra,
})

const VERSIONS: Record<number, PersonaVersion[]> = {
  1: [
    v(
      7,
      'SAVED',
      '복창 한 번에, 전화번호 끊어 복창, 발화 속도 보통 → 빠르게',
      '김지훈',
      '2026-10-30',
      V7,
      {
        basedOn: 6,
        voice: voice('marin', 'FAST', 'NORMAL'),
      },
    ),
    v(6, 'ACTIVE', '품목 분류 문장 정리', '김지훈', '2026-10-02', V6, {
      voice: voice('marin', 'NORMAL', 'NORMAL'),
    }),
    v(5, 'PAST', '말 끝 기다리기 짧게 → 보통', '한예린', '2026-09-17', V6, {
      voiceOnly: true,
      voice: voice('marin', 'NORMAL', 'NORMAL'),
    }),
    v(4, 'PAST', '첫 인사 문구 단축', '오승현', '2026-09-01', V6),
    v(3, 'PAST', '복창을 전송 전 한 번으로 묶음', '윤태호', '2026-08-18', V3),
    v(2, 'PAST', '되묻기 문장 다듬기', '이재훈', '2026-08-11', V3),
    v(1, 'PAST', '처음 만듦', '이재훈', '2026-08-04', [ROLE, steps('항목마다')].join('\n\n')),
  ],
  2: [
    v(3, 'ACTIVE', '안내 문장을 존댓말로 통일', '한예린', '2026-09-24', V3, {
      voice: voice('cedar', 'SLOW', 'LONG'),
    }),
    v(2, 'PAST', '말 끝 기다리기 보통 → 길게', '한예린', '2026-09-10', V3, {
      voiceOnly: true,
      voice: voice('cedar', 'SLOW', 'LONG'),
    }),
    v(1, 'PAST', '처음 만듦', '오승현', '2026-09-03', V3, {
      voice: voice('cedar', 'SLOW', 'NORMAL'),
    }),
  ],
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
