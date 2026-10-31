// 07 페르소나 관리 Model — 페르소나(AI 상담사 말투 · 목소리 묶음)와 버전(시스템 프롬프트 + 음성 설정 기록). React를 모르는 데이터 층
// 명세 확인 전 (04 · 09 · 03과 같은 방식) → 지금은 네트워크 없이 메모리 가짜 데이터. 명세가 오면 fetch* 몸통만 바꾸면 됨
// 버전 날짜 · 번호는 02 대시보드 '버전별 기록' 가짜(v6 10.02 · v5 09.17 · v4 09.01)와 같게
import { queryOptions } from '@tanstack/react-query'

export type Speed = 'SLOW' | 'NORMAL' | 'FAST' // 발화 속도
export type WaitTime = 'SHORT' | 'NORMAL' | 'LONG' // 고객 말 끝을 기다리는 시간

/** 음성 설정 — 버전마다 따로 (프롬프트와 함께 저장, 음성만 바꾼 버전 = '음성 설정' 태그) */
export interface VoiceSettings {
  voice: string // TTS 목소리 이름 'marin'
  speed: Speed
  waitTime: WaitTime
}

/** 고를 수 있는 목소리 — shortcut: 가짜 목록. 실제 목록은 BE(TTS 제공사)에서 받아야 함 */
export const VOICES = ['marin', 'cedar', 'coral', 'sage'] as const

export interface Persona {
  personaSeq: number
  name: string // '빠른 접수형'
  voice: VoiceSettings // 적용 중인 버전의 음성 (목록 칸 'marin · 속도 보통')
  inUse: boolean // 지금 통화에 쓰는 페르소나 (한 번에 하나)
  activeVersion: number // 적용 중인 버전
  pendingVersion: number | null // 저장됐지만 아직 적용 안 한 최신 버전 ('v7 저장됨')
}

/** 서버에 있는 버전의 상태: 저장됨(아직 적용 안 함) · 적용 중 · 지난 버전
 * '작성 중'은 서버에 없음 — 수정 화면에서 저장하기 전 상태일 뿐 (10/31 결정) */
export type VersionStatus = 'SAVED' | 'ACTIVE' | 'PAST'

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

export async function fetchPersonas(): Promise<Persona[]> {
  await wait()
  return PERSONAS.map((p) => ({ ...p, voice: { ...p.voice } }))
}

/** 버전 기록 — 최신부터 */
export async function fetchVersions(personaSeq: number): Promise<PersonaVersion[]> {
  await wait()
  return (VERSIONS[personaSeq] ?? []).map((x) => ({ ...x, voice: { ...x.voice } }))
}

/** 수정한 프롬프트 · 음성 설정을 새 버전으로 저장 — 저장할 때마다 항상 '가장 큰 번호 + 1' (덮어쓰지 않음, 10/31 결정). 저장된 번호를 돌려줌
 * 저장 = '저장됨'(아직 통화엔 안 씀). 적용(통화에 쓰기)은 따로. 저장 전 '작성 중'은 화면에만 있고 여기로 오지 않음 */
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
  const today = new Date().toLocaleDateString('sv-SE') // 'YYYY-MM-DD' (화면 시간대)
  const base = list.find((x) => x.version === input.basedOn)
  list.unshift(
    v(version, 'SAVED', input.summary, input.author, today, input.prompt, {
      basedOn: input.basedOn,
      voice: { ...input.voice },
      voiceOnly: base?.prompt === input.prompt, // 프롬프트는 그대로, 음성만 바뀜 → '음성 설정' 태그
    }),
  )
  persona.pendingVersion = version
  return version
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
    name: '빠른 접수형',
    voice: voice('marin', 'NORMAL', 'NORMAL'),
    inUse: true,
    activeVersion: 6,
    pendingVersion: 7,
  },
  {
    personaSeq: 2,
    name: '친절 안내형',
    voice: voice('cedar', 'SLOW', 'LONG'),
    inUse: false,
    activeVersion: 3,
    pendingVersion: null,
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
