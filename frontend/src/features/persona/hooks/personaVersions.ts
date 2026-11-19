// AI 상담가의 버전 계산 — 다시 쓸 때 보낼 칸 · 통화에 쓰는 내용과의 관계(반영 전 · 시험할 대상) · 고칠 대상
// React를 모르는 순수 함수 (실행해서 확인: personaVersions.test.ts). 상태 · 요청은 usePersonaPage
import { PROMPT_KEYS, type Persona, type PersonaVersion } from '../api/personaMap'
import type { EditTarget } from './usePromptEditor'

/** 다시 쓰기 = 고른 버전(v) 내용으로 저장. 수정의 시작점(latest)과 다른 칸만 보냄 — 수정 [저장]과 같은 규칙. same = 보낼 것이 없음 */
export function reuseDiff(v: PersonaVersion, latest: PersonaVersion) {
  const prompt = Object.fromEntries(
    PROMPT_KEYS.filter((k) => v.prompt[k] !== latest.prompt[k]).map((k) => [k, v.prompt[k]]),
  )
  const voice = {
    ...(v.voice.voice !== latest.voice.voice && { voice: v.voice.voice }),
    ...(v.voice.speed !== latest.voice.speed && { speed: v.voice.speed }),
    ...(v.voice.waitTime !== latest.voice.waitTime && { waitTime: v.voice.waitTime }),
  }
  const name = v.name !== latest.name ? v.name : undefined
  const same = name === undefined && !Object.keys(prompt).length && !Object.keys(voice).length
  return { name, prompt, voice, same }
}

/** 프롬프트 · 목소리가 같은가 (이름만 바꿈 · 고쳤다가 되돌림) — AI가 받는 것이 그대로라 시험할 것이 없음 */
const sameTalk = (a: PersonaVersion, b: PersonaVersion) =>
  PROMPT_KEYS.every((k) => a.prompt[k] === b.prompt[k]) &&
  a.voice.voice === b.voice.voice &&
  a.voice.speed === b.voice.speed &&
  a.voice.waitTime === b.voice.waitTime

/** 현재 버전이 아직 통화에 안 쓰임 (적용 대기 중이면 기다림) */
const newerThanCall = (p: Persona) =>
  p.inUse && !p.applyingVersion && p.head.version !== p.appliedVersion

/** 고른 상담가와 통화의 관계 — 띠가 뜨는지 · 무엇을 시험하고 반영하는지
 *  all = 그 상담가의 버전들, head = 현재 버전 */
export function callStateOf(
  persona: Persona | null,
  all: PersonaVersion[],
  head: PersonaVersion | null,
) {
  // 반영 전 띠 — 사용 중 상담가의 현재 버전이 아직 통화에 안 쓰일 때
  const unapplied = !!persona && newerThanCall(persona)
  // 토글 '통화에 쓰는 내용' — 그 버전을 못 찾으면(목록 밖) 토글 없음
  const callVersion = unapplied
    ? (all.find((v) => v.version === persona.appliedVersion) ?? null)
    : null
  // 6번 — 통화에 안 쓰는 상담가를 통화에 쓰기: 현재 버전을 먼저 시험. 모두 통과해도 저절로 바꾸지 않음(담당자가 [통화에 사용하기])
  const switching = !!persona && !persona.inUse
  // 띠가 뜰 상담가 — 목록만으로 앎
  const banded = unapplied || (switching && !persona.applyingVersion)
  return {
    unapplied,
    callVersion,
    // 고친 내용이 통화에 쓰는 내용과 같음 → 시험 없이 [통화에 반영]
    sameTalk: !!callVersion && !!head && sameTalk(head, callVersion),
    switching,
    banded,
    // 띠의 시험 → 반영 대상 — 반영 전인 고친 내용(현재 버전) · 6번은 안 쓰는 상담가의 현재 버전
    applyTarget:
      banded && persona && head && !head.isDraft
        ? {
            personaSeq: persona.personaSeq,
            head: persona.head,
            promptText: head.promptText,
            voiceId: head.voice.voice || null,
          }
        : null,
  }
}

/** [수정]은 늘 맨 위에서 시작 — 남은 초안이 있으면 그 내용, 없으면 현재 버전. latest = 버전 기록의 맨 위
 *  저장 직후 목록(현재 버전 번호)이 버전 기록보다 먼저 오면 옛 글로 입력 칸이 새로 떠 '고치는 중'처럼 보였음
 *  → 버전 기록이 따라올 때까지 입력 칸을 띄우지 않음 (남은 초안이 있으면 맨 위가 초안이라 비교 안 함) */
export function editTargetOf(
  persona: Persona | null,
  latest: PersonaVersion | null,
): EditTarget | null {
  if (!persona || !latest) return null
  if (!persona.draftRevision && latest.version !== persona.head.version) return null
  return {
    personaSeq: persona.personaSeq,
    personaName: latest.name,
    prompt: latest.prompt,
    voice: latest.voice,
    basedOn: persona.head.version,
    draftRevision: persona.draftRevision,
    saveTo: persona.head.version + 1,
  }
}
