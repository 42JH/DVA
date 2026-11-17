// 실행: npx tsx --tsconfig tsconfig.app.json src/features/persona/hooks/personaVersions.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import {
  PROMPT_KEYS,
  type Persona,
  type PersonaVersion,
  type PromptFields,
} from '@/features/persona/api/personaMap'
import { callStateOf, editTargetOf, reuseDiff } from './personaVersions'

const fields = (over: Partial<PromptFields> = {}): PromptFields => ({
  ...(Object.fromEntries(PROMPT_KEYS.map((k) => [k, `${k} 글`])) as PromptFields),
  ...over,
})
const ver = (version: number, over: Partial<PersonaVersion> = {}): PersonaVersion => ({
  version,
  name: '빠른 접수형',
  status: 'PAST',
  isHead: false,
  isDraft: false,
  author: '김관리',
  promptText: `v${version} 글`,
  savedAt: '2026-11-14T10:00:00+09:00',
  prompt: fields(),
  voice: { voice: '', speed: 'NORMAL', waitTime: 'NORMAL' },
  ...over,
})
const persona = (over: Partial<Persona> = {}): Persona => ({
  personaSeq: 1,
  code: 'quick',
  name: '빠른 접수형',
  voice: { voice: '', speed: 'NORMAL', waitTime: 'NORMAL' },
  inUse: true,
  appliedVersion: 4,
  head: { version: 4, seq: 104 },
  draftRevision: null,
  applyingVersion: null,
  applyError: null,
  ...over,
})

// 다시 쓰기: 맨 위(latest)와 다른 칸만 보냄. 다 같으면 보낼 것이 없음
const latest = ver(5, { prompt: fields({ tone: '고친 말투' }), name: '새 이름' })
const old = ver(3, { voice: { voice: 'f1', speed: 'FAST', waitTime: 'NORMAL' } })
assert.deepEqual(reuseDiff(old, latest), {
  name: '빠른 접수형',
  prompt: { tone: 'tone 글' },
  voice: { voice: 'f1', speed: 'FAST' },
  same: false,
})
assert.deepEqual(reuseDiff(ver(2), ver(5)), { name: undefined, prompt: {}, voice: {}, same: true })

// 통화에 쓰는 상담가 · 현재 버전이 통화에 쓰는 버전 → 띠 없음
const v4 = ver(4, { isHead: true, status: 'ACTIVE' })
const calm = callStateOf(persona(), [v4], v4)
assert.deepEqual(
  [calm.unapplied, calm.switching, calm.banded, calm.applyTarget],
  [false, false, false, null],
)

// 반영 전: 사용 중 상담가의 현재 버전(v5)이 아직 통화(v4)에 안 쓰임 → 띠 · 시험 대상 = 현재 버전
const v5 = ver(5, { isHead: true, prompt: fields({ tone: '고친 말투' }) })
const pending = callStateOf(persona({ head: { version: 5, seq: 105 } }), [v5, v4], v5)
assert.deepEqual(
  [pending.unapplied, pending.callVersion, pending.sameTalk, pending.banded],
  [true, v4, false, true],
)
assert.deepEqual(pending.applyTarget, {
  personaSeq: 1,
  head: { version: 5, seq: 105 },
  promptText: 'v5 글',
  voiceId: null, // 기본 음성('')은 null로
})
// 이름만 바꾼 버전 — AI가 받는 것이 같아 시험할 것이 없음
const renamed = ver(5, { isHead: true, name: '새 이름' })
assert.equal(
  callStateOf(persona({ head: { version: 5, seq: 105 } }), [renamed, v4], renamed).sameTalk,
  true,
)
// 반영 중(적용 대기)이면 기다림 — 반영 전이 아님
assert.equal(
  callStateOf(persona({ head: { version: 5, seq: 105 }, applyingVersion: 5 }), [v5, v4], v5)
    .unapplied,
  false,
)
// 남은 초안이 맨 위면 시험 대상 없음 (저장해야 버전이 됨)
const draft = ver(6, { isDraft: true })
assert.equal(
  callStateOf(persona({ head: { version: 5, seq: 105 } }), [draft, v5, v4], draft).applyTarget,
  null,
)

// 통화에 안 쓰는 상담가(6번): 띠가 뜰 상담가 · 바꾸는 중(적용 대기)이면 아님
const other = persona({
  personaSeq: 2,
  inUse: false,
  appliedVersion: 2,
  head: { version: 2, seq: 202 },
})
const v2 = ver(2, { isHead: true, voice: { voice: 'm1', speed: 'NORMAL', waitTime: 'NORMAL' } })
const sw = callStateOf(other, [v2], v2)
assert.deepEqual(
  [sw.switching, sw.unapplied, sw.banded, sw.applyTarget?.voiceId],
  [true, false, true, 'm1'],
)
assert.equal(callStateOf({ ...other, applyingVersion: 2 }, [v2], v2).banded, false)
assert.deepEqual(callStateOf(null, [], null).applyTarget, null)

// 고칠 대상: 버전 기록의 맨 위에서 시작, 저장하면 현재 버전 + 1
assert.deepEqual(
  [editTargetOf(persona(), v4)?.basedOn, editTargetOf(persona(), v4)?.saveTo],
  [4, 5],
)
// 저장 직후 목록(v5)이 버전 기록(v4)보다 먼저 옴 → 따라올 때까지 입력 칸을 띄우지 않음
assert.equal(editTargetOf(persona({ head: { version: 5, seq: 105 } }), v4), null)
// 남은 초안이 있으면 맨 위가 초안 — 번호가 달라도 그 내용으로 시작
assert.equal(
  editTargetOf(persona({ draftRevision: 'rev-1' }), ver(5, { isDraft: true, name: '초안 이름' }))
    ?.personaName,
  '초안 이름',
)
assert.equal(editTargetOf(null, v4), null)
