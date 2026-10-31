// 07 페르소나 관리 Model — 페르소나(AI 상담사 말투 · 목소리 묶음)와 버전(시스템 프롬프트 기록). React를 모르는 데이터 층
// 명세 확인 전 (04 · 09 · 03과 같은 방식) → 지금은 네트워크 없이 메모리 가짜 데이터. 명세가 오면 fetch* 몸통만 바꾸면 됨
// 버전 날짜 · 번호는 02 대시보드 '버전별 기록' 가짜(v6 10.02 · v5 09.17 · v4 09.01)와 같게
import { queryOptions } from '@tanstack/react-query'

export type Speed = 'SLOW' | 'NORMAL' | 'FAST' // 발화 속도
export type WaitTime = 'SHORT' | 'NORMAL' | 'LONG' // 고객 말 끝을 기다리는 시간

export interface Persona {
  personaSeq: number
  name: string // '빠른 접수형'
  voice: string // TTS 목소리 이름 'marin'
  speed: Speed
  waitTime: WaitTime
  inUse: boolean // 지금 통화에 쓰는 페르소나 (한 번에 하나)
  activeVersion: number // 적용 중인 버전
  draftVersion: number | null // 작성 중(아직 적용 안 한) 버전
}

/** 버전 상태: 작성 중(저장 전) · 적용 중 · 지난 버전 */
export type VersionStatus = 'DRAFT' | 'ACTIVE' | 'PAST'

export interface PersonaVersion {
  version: number
  status: VersionStatus
  voiceOnly: boolean // 프롬프트는 그대로, 음성 설정만 바꾼 버전 ('음성 설정' 태그)
  summary: string // 무엇을 바꿨는지 한 줄
  author: string | null // 작성 중이면 null
  savedAt: string | null // 'YYYY-MM-DD'. 작성 중이면 null ('저장 전')
  basedOn: number | null // 어느 버전에서 시작했는지 (작성 중일 때 'v6에서 시작')
  prompt: string
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
  return PERSONAS.map((p) => ({ ...p }))
}

/** 버전 기록 — 최신(작성 중)부터 */
export async function fetchVersions(personaSeq: number): Promise<PersonaVersion[]> {
  await wait()
  return (VERSIONS[personaSeq] ?? []).map((v) => ({ ...v }))
}

// ---------- 가짜 데이터 = 와이어프레임 07 ----------
const PERSONAS: Persona[] = [
  {
    personaSeq: 1,
    name: '빠른 접수형',
    voice: 'marin',
    speed: 'NORMAL',
    waitTime: 'NORMAL',
    inUse: true,
    activeVersion: 6,
    draftVersion: 7,
  },
  {
    personaSeq: 2,
    name: '친절 안내형',
    voice: 'cedar',
    speed: 'SLOW',
    waitTime: 'LONG',
    inUse: false,
    activeVersion: 3,
    draftVersion: null,
  },
]

// 프롬프트 조각 — 버전마다 조금씩 다름 (v6 → v7: 복창을 한 번에, 전화번호 끊어 복창 추가)
const ROLE = '# 역할\n너는 디버 택배 전화 접수 AI다. 짧고 또렷하게 말한다.'
const steps = (readBack: string) =>
  `# 접수 순서\n1. 보내는 분 이름과 전화번호를 받는다.\n2. 받는 분 이름, 전화번호, 주소를 받는다.\n3. 물품 종류와 박스 크기를 묻는다.\n4. 보내기 전에 받은 내용을 ${readBack} 복창한다.`
const ASK = '# 되묻기\n- 잘 들리지 않은 항목만 다시 묻는다.\n- 확인된 항목은 다시 묻지 않는다.'
const PHONE = '- 전화번호는 세 자리, 네 자리, 네 자리로 끊어 복창한다.'
const ADDRESS =
  '# 주소 확인\n- 검색 결과가 1건이면 다시 묻지 않고 확정한다.\n- 여러 건이면 동 이름으로 한 번만 좁혀 묻는다.\n- 상세주소는 고객이 말한 그대로 받는다.'
const V7 = [ROLE, steps('한 번에'), `${ASK}\n${PHONE}`, ADDRESS].join('\n\n')
const V6 = [ROLE, steps('항목마다'), ASK, ADDRESS].join('\n\n')
const V3 = [ROLE, steps('항목마다'), ASK].join('\n\n')

const v = (
  version: number,
  status: VersionStatus,
  summary: string,
  author: string | null,
  savedAt: string | null,
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
  ...extra,
})

const VERSIONS: Record<number, PersonaVersion[]> = {
  1: [
    v(7, 'DRAFT', '복창 한 번에, 전화번호 끊어 복창, 발화 속도 보통 → 빠르게', null, null, V7, {
      basedOn: 6,
    }),
    v(6, 'ACTIVE', '품목 분류 문장 정리', '김지훈', '2026-10-02', V6),
    v(5, 'PAST', '말 끝 기다리기 짧게 → 보통', '한예린', '2026-09-17', V6, { voiceOnly: true }),
    v(4, 'PAST', '첫 인사 문구 단축', '오승현', '2026-09-01', V6),
    v(3, 'PAST', '복창을 전송 전 한 번으로 묶음', '윤태호', '2026-08-18', V3),
    v(2, 'PAST', '되묻기 문장 다듬기', '이재훈', '2026-08-11', V3),
    v(1, 'PAST', '처음 만듦', '이재훈', '2026-08-04', [ROLE, steps('항목마다')].join('\n\n')),
  ],
  2: [
    v(3, 'ACTIVE', '안내 문장을 존댓말로 통일', '한예린', '2026-09-24', V3),
    v(2, 'PAST', '말 끝 기다리기 보통 → 길게', '한예린', '2026-09-10', V3, { voiceOnly: true }),
    v(1, 'PAST', '처음 만듦', '오승현', '2026-09-03', V3),
  ],
}
