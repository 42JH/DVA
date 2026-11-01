// 실행: npx tsx --tsconfig tsconfig.app.json src/features/persona/api/personaMap.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import {
  lastApplied,
  toPersona,
  toRate,
  toSpeed,
  toVersions,
  type PersonaDto,
  type PersonaVersionDto,
} from './personaMap'

const ver = (version: number, extra: Partial<PersonaVersionDto> = {}): PersonaVersionDto => ({
  aiPersonaVersionSeq: 100 + version,
  version,
  name: '빠른 접수형',
  promptText: 'A',
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
assert.equal(toRate('FAST', null), null) // 숫자 속도 미지원

// 쓰는 중인 페르소나: v4 적용 중 · v5 저장(적용 안 함, 최신) · v3 음성만 바뀜
const a = [
  ver(5, { promptText: 'B' }),
  ver(4, { status: 'ACTIVE', appliedAt: '2026-11-01T00:00:00Z' }),
  ver(3, { speakingRate: 1.2, appliedAt: '2026-10-01T00:00:00Z' }),
  ver(2),
  ver(1, { createdByAdminUserName: null }),
]
assert.equal(lastApplied(a), 4)
const av = toVersions([...a].reverse(), 5) // 서버 순서와 상관없이 높은 번호가 위
assert.deepEqual(
  av.map((v) => [v.version, v.status, v.isHead]),
  [
    [5, 'SAVED', true],
    [4, 'ACTIVE', false],
    [3, 'PAST', false],
    [2, 'PAST', false],
    [1, 'PAST', false],
  ],
)
assert.equal(av[0]!.changes.prompt, true)
assert.deepEqual(av[1]!.changes.speed, ['FAST', 'NORMAL']) // v3 빠르게 → v4 보통
assert.equal(av[1]!.voiceOnly, true)
assert.equal(av[4]!.changes.first, true)
assert.equal(av[4]!.author, '')

const dto = (
  head: PersonaVersionDto,
  active: PersonaVersionDto | null,
  pending = null,
): PersonaDto => ({
  aiPersonaSeq: 1,
  code: 'parcel-fast',
  headVersion: head,
  activeVersion: active,
  pendingVersion: pending,
})
const pa = toPersona(dto(a[0]!, a[1]!), a)
assert.deepEqual(
  [pa.inUse, pa.appliedVersion, pa.savedVersion, pa.head, pa.applyingVersion],
  [true, 4, 5, { version: 5, seq: 105 }, null],
)

// 통화에 안 쓰는 페르소나: 예전에 v3 적용 → 기준 = v3('마지막 적용'), v4 저장됨
const b = [ver(4), ver(3, { appliedAt: '2026-10-01T00:00:00Z', voiceId: null }), ver(2), ver(1)]
const pb = toPersona(dto(b[0]!, null), b)
assert.deepEqual([pb.inUse, pb.appliedVersion, pb.savedVersion], [false, 3, 4])
assert.equal(pb.voice.voice, '') // 기본 음성 = ''
assert.deepEqual(
  toVersions(b, 4).map((v) => v.status),
  ['SAVED', 'APPLIED', 'PAST', 'PAST'],
)

// 한 번도 적용 안 한 페르소나: 기준 없음, 최신본 = 저장됨
const c = [ver(2), ver(1)]
const pc = toPersona(dto(c[0]!, null), c)
assert.deepEqual([pc.appliedVersion, pc.savedVersion], [null, 2])
assert.deepEqual(
  toVersions(c, 2).map((v) => v.status),
  ['SAVED', 'PAST'],
)

// 적용 대기 중인 최신본은 '저장됨'이 아님
const d = [
  ver(5, { status: 'PENDING', applyErrorCode: 'AI_UNAVAILABLE' }),
  ver(4, { status: 'ACTIVE' }),
]
const pd = toPersona({ ...dto(d[0]!, d[1]!), pendingVersion: d[0]! }, d)
assert.deepEqual([pd.savedVersion, pd.applyingVersion, pd.applyError], [null, 5, 'AI_UNAVAILABLE'])

console.log('personaMap OK')
