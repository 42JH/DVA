// 시연 모드 (11/09 사용자): 기업 시연 중 AI 상담가를 고쳐도 실서버 AI 설정에 가지 않게
// 읽기는 실서버에서 한 번 받아 시작점으로 쓰고, 저장 · 적용 · 추가는 이 브라우저 안에서만 바뀜 (새로고침하면 실서버 상태로)
// 끄려면 PERSONA_DEMO = false → personaApi가 다시 실서버로 저장 · 적용함
import { fetchAll } from '@/shared/api/paging'
import {
  toPrompt,
  type PersonaDraftDto,
  type PersonaDto,
  type PersonaVersionDto,
  type PromptFields,
  type WaitTime,
} from './personaMap'

export const PERSONA_DEMO = true

/** 저장 · 추가 본문 — 서버로 보내던 것과 같은 모양 */
interface PersonaBody extends Partial<PromptFields> {
  name?: string
  voiceId?: string | null
  speakingRate?: number | null
  turnWaitLevel?: WaitTime
}

let personas: PersonaDto[] | null = null
const versions = new Map<number, PersonaVersionDto[]>()
let nextSeq = 900_000 // 시연에서 새로 생긴 번호 (실서버 번호와 겹치지 않게 크게)

const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const now = () => new Date().toISOString()

async function list(signal?: AbortSignal) {
  personas ??= await fetchAll<PersonaDto>('/personas', {}, signal)
  return personas
}
async function find(personaSeq: number) {
  const p = (await list()).find((x) => x.aiPersonaSeq === personaSeq)
  if (!p) throw new Error('없는 상담가입니다.')
  return p
}

export const demoPersonas = async (signal?: AbortSignal) => copy(await list(signal))

export async function demoVersions(personaSeq: number, signal?: AbortSignal) {
  if (!versions.has(personaSeq))
    versions.set(
      personaSeq,
      await fetchAll<PersonaVersionDto>(`/personas/${personaSeq}/versions`, {}, signal),
    )
  const p = (await list(signal)).find((x) => x.aiPersonaSeq === personaSeq)!
  return { persona: copy(p), list: copy(versions.get(personaSeq)!) }
}

/** 저장 — 초안을 만들거나 덮어씀 (빠진 칸은 지금 초안 · 없으면 적용본에서) */
export async function demoSaveDraft(personaSeq: number, body: PersonaBody) {
  const p = await find(personaSeq)
  const base: PersonaDraftDto | PersonaVersionDto = p.draft ?? p.headVersion
  const { name, voiceId, speakingRate, turnWaitLevel, ...prompt } = body // prompt = 보낸 칸만
  p.draft = {
    draftRevision: crypto.randomUUID(),
    baseVersion: p.headVersion.version,
    ...toPrompt(base),
    ...prompt,
    name: name ?? base.name,
    voiceId: voiceId !== undefined ? voiceId : base.voiceId,
    speakingRate: speakingRate !== undefined ? speakingRate : base.speakingRate,
    turnWaitLevel: turnWaitLevel ?? base.turnWaitLevel,
    updatedAt: now(),
  }
}

/** [적용] — 초안이 있으면 새 버전으로 확정하고, 그 버전을 바로 통화에 쓰는 것으로 (시연이라 적용 대기 없이) */
export async function demoApply(personaSeq: number) {
  const p = await find(personaSeq)
  if (!versions.has(personaSeq)) await demoVersions(personaSeq)
  const list = versions.get(personaSeq)!
  if (p.draft) {
    const v: PersonaVersionDto = {
      aiPersonaVersionSeq: nextSeq++,
      version: p.headVersion.version + 1,
      name: p.draft.name,
      ...toPrompt(p.draft),
      voiceId: p.draft.voiceId,
      speakingRate: p.draft.speakingRate,
      turnWaitLevel: p.draft.turnWaitLevel,
      status: 'INACTIVE',
      createdByAdminUserName: '시연',
      createdAt: now(),
      appliedAt: null,
      applyErrorCode: null,
    }
    list.push(v)
    p.headVersion = v
    p.draft = null
  }
  // 통화에 쓰는 상담가는 서비스 전체에 하나
  for (const other of personas!) {
    other.activeVersion = null
    other.pendingVersion = null
    for (const v of versions.get(other.aiPersonaSeq) ?? [])
      if (v.status === 'ACTIVE' || v.status === 'PENDING') v.status = 'INACTIVE'
  }
  const head = list.find((v) => v.version === p.headVersion.version)!
  head.status = 'ACTIVE'
  head.appliedAt = now()
  p.headVersion = head
  p.activeVersion = head
}

/** 상담가 추가 — v1 저장(통화에는 안 씀) */
export async function demoCreate(code: string, body: Required<PersonaBody>) {
  const all = await list()
  if (all.some((p) => p.code === code)) throw new Error('같은 코드의 상담가가 있습니다.')
  const v1: PersonaVersionDto = {
    aiPersonaVersionSeq: nextSeq++,
    version: 1,
    ...body,
    status: 'INACTIVE',
    createdByAdminUserName: '시연',
    createdAt: now(),
    appliedAt: null,
    applyErrorCode: null,
  }
  const seq = nextSeq++
  all.push({
    aiPersonaSeq: seq,
    code,
    headVersion: v1,
    activeVersion: null,
    pendingVersion: null,
    draft: null,
  })
  versions.set(seq, [v1])
  return seq
}
