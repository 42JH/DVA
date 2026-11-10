// 실행: npx tsx --tsconfig tsconfig.app.json src/features/persona/api/personaMap.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import {
  PROMPT_KEYS,
  toPersona,
  toRate,
  toSpeed,
  toVersions,
  type PersonaDraftDto,
  type PersonaDto,
  type PersonaVersionDto,
  type PromptFields,
} from './personaMap'

// 여섯 칸 모두 같은 글 — 칸 하나만 바꾸는 경우는 { ...fields('A'), tone: 'B' }
const fields = (text: string) =>
  Object.fromEntries(PROMPT_KEYS.map((k) => [k, text])) as PromptFields

const ver = (version: number, extra: Partial<PersonaVersionDto> = {}): PersonaVersionDto => ({
  aiPersonaVersionSeq: 100 + version,
  version,
  name: '빠른 접수형',
  ...fields('A'),
  voiceId: 'marin',
  speakingRate: null,
  turnWaitLevel: 'NORMAL',
  status: 'INACTIVE',
  createdByAdminUserName: '김지훈',
  createdAt: '2026-11-02T01:00:00Z',
  appliedAt: null,
  applyErrorCode: null,
  ...extra,
})

// 속도: null · 1 = 보통, 칩 → 숫자는 범위 안으로, 범위 없으면 null
assert.equal(toSpeed(null), 'NORMAL')
assert.equal(toSpeed(1), 'NORMAL')
assert.equal(toSpeed(0.9), 'SLOW')
assert.equal(toSpeed(1.1), 'FAST')
assert.equal(toRate('NORMAL', { min: 0.5, max: 2 }), null)
assert.equal(toRate('SLOW', { min: 0.5, max: 2 }), 0.85)
assert.equal(toRate('FAST', { min: 0.5, max: 1.1 }), 1.1) // 범위 끝
assert.equal(toRate('FAST', null), 1.2) // 숫자 속도 미지원이어도 그대로 → 서버가 거절

const draft = (extra: Partial<PersonaDraftDto> = {}): PersonaDraftDto => ({
  draftRevision: 'rev-1',
  baseVersion: 4,
  name: '빠른 접수형',
  ...fields('C'),
  voiceId: 'marin',
  speakingRate: null,
  turnWaitLevel: 'NORMAL',
  updatedAt: '2026-11-02T03:00:00Z',
  ...extra,
})
const dto = (
  head: PersonaVersionDto,
  active: PersonaVersionDto | null,
  extra: Partial<PersonaDto> = {},
): PersonaDto => ({
  aiPersonaSeq: 1,
  code: 'parcel-fast',
  headVersion: head,
  activeVersion: active,
  pendingVersion: null,
  draft: null,
  ...extra,
})

// 쓰는 중인 페르소나: v4 적용 중(= HEAD) · 초안 저장됨 → 화면 'v5 저장됨' · v3 음성만 바뀜
const a = [
  ver(4, { status: 'ACTIVE', appliedAt: '2026-11-01T00:00:00Z' }),
  ver(3, { speakingRate: 1.2 }),
  ver(2),
  ver(1, { createdByAdminUserName: null }),
]
const av = toVersions([...a].reverse(), 4, draft()) // 서버 순서와 상관없이 높은 번호가 위
assert.deepEqual(
  av.map((v) => [v.version, v.status, v.isHead, v.isDraft]),
  [
    [5, 'SAVED', false, true], // 초안 = HEAD + 1
    [4, 'ACTIVE', true, false],
    [3, 'PAST', false, false],
    [2, 'PAST', false, false],
    [1, 'PAST', false, false],
  ],
)
assert.deepEqual(av[0]!.prompt, fields('C')) // 서버 다른 칸은 안 섞임
assert.equal(av[0]!.changes.prompt, true) // 초안도 바로 앞(HEAD)과 비교
assert.deepEqual(av[1]!.changes.speed, ['FAST', 'NORMAL']) // v3 빠르게 → v4 보통
assert.equal(av[1]!.voiceOnly, true)
assert.equal(av[4]!.changes.first, true)
assert.equal(av[4]!.author, '')
const pa = toPersona(dto(a[0]!, a[0]!, { draft: draft() }))
assert.deepEqual(
  [pa.inUse, pa.appliedVersion, pa.savedVersion, pa.head, pa.draftRevision],
  [true, 4, 5, { version: 4, seq: 104 }, 'rev-1'],
)

// 초안이 없으면 버전 기록 그대로, 저장됨 없음
assert.deepEqual(
  toVersions(a, 4, null).map((v) => v.status),
  ['ACTIVE', 'PAST', 'PAST', 'PAST'],
)
assert.equal(toPersona(dto(a[0]!, a[0]!)).savedVersion, null)

// 통화에 안 쓰는 페르소나: 적용본 = HEAD(appliedAt이 없어도) → '마지막 적용'
const b = [ver(3, { voiceId: null }), ver(2), ver(1)]
const pb = toPersona(dto(b[0]!, null))
assert.deepEqual([pb.inUse, pb.appliedVersion, pb.savedVersion], [false, 3, null])
assert.equal(pb.voice.voice, '') // 기본 음성 = ''
assert.deepEqual(
  toVersions(b, 3, null).map((v) => v.status),
  ['APPLIED', 'PAST', 'PAST'],
)

// 확정은 됐는데 적용 요청이 실패: HEAD v5 > 적용 중 v4 → v5 '저장됨'(적용 다시), 적용본은 v4
const c = [ver(5, fields('B')), ver(4, { status: 'ACTIVE' })]
const pc = toPersona(dto(c[0]!, c[1]!))
assert.deepEqual([pc.appliedVersion, pc.savedVersion], [4, 5])
assert.deepEqual(
  toVersions(c, 5, null).map((v) => v.status),
  ['SAVED', 'ACTIVE'],
)

// 적용 대기 중인 HEAD는 '저장됨'이 아님
const d = [
  ver(5, { status: 'PENDING', applyErrorCode: 'AI_UNAVAILABLE' }),
  ver(4, { status: 'ACTIVE' }),
]
const pd = toPersona(dto(d[0]!, d[1]!, { pendingVersion: d[0]! }))
assert.deepEqual([pd.savedVersion, pd.applyingVersion, pd.applyError], [null, 5, 'AI_UNAVAILABLE'])

// 프롬프트 변경: 여섯 칸 중 하나만 달라도 바뀜(음성만 바뀐 버전 아님), 다 같으면 안 바뀜
const e = toVersions([ver(2, { tone: 'B' }), ver(1)], 2, null)
assert.deepEqual([e[0]!.changes.prompt, e[0]!.voiceOnly], [true, false])
assert.equal(toVersions([ver(2), ver(1)], 2, null)[0]!.changes.prompt, false)

console.log('personaMap OK')
