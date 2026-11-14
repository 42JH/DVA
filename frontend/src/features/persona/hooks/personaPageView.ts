// AI 상담가 화면에 그릴 값 만들기 — 위 탭 · 프롬프트 카드 · 수정 기록 창 · 띠. 상태 · 요청은 usePersonaPage
import { fmtVersionTime } from '@/shared/lib/format'
import type { Tone } from '@/shared/ui'
import { PROMPT_SECTIONS, VERSION_BADGE } from '@/features/persona/labels'
import { inlineDiff, type Part } from '@/features/persona/hooks/lineDiff'
import { nameI, type BandStep } from '@/features/persona/hooks/personaBand'
import type { useApplyTest } from '@/features/persona/hooks/useApplyTest'
import type { Persona, PersonaVersion, PromptKey } from '@/features/persona/api/personaMap'

/** 오른쪽 상담가 카드 한 장 */
export interface PersonaItem {
  personaSeq: number
  name: string
  selected: boolean
  inUse: boolean // '통화에 사용 중' 태그
  applying: string | null // '적용 대기' — 통화에 쓰려고 AI 확인을 기다리는 중
  canUse: boolean // [통화에 사용하기] — 통화에 안 쓰는 상담가만. 사용 중 상담가의 새 버전은 버전 기록의 [통화에 반영하기] (11/13)
  deletable: boolean // [삭제] 버튼 — 관리 권한 + 통화에 사용 중도 적용 대기도 아닐 때만
}

type Badge = { label: string; tone: Tone }

/** 버전 기록 한 줄 (11/11 — Notion 버전 기록처럼 저장 시각 + 수정한 사람) */
export interface HistoryRow {
  version: number
  time: string // '오늘 오후 3:07'
  author: string // 모르면 ''
  badges: Badge[] // 반영 전 · 통화에 사용 중 · 적용 대기
  selected: boolean
}

/** 가운데 프롬프트 카드 */
interface PromptView {
  time: string
  voice: string // 목소리 이름 '기본 음성' · '여성 1' — 못 고칠 때(시험 · 반영 중) 머리 줄에
  sections: {
    key: PromptKey
    group: string | null
    sub: boolean
    title: string
    text: string
    // 수정 기록 창에서만 — 통화에 쓰는 내용 기준 비교. 한 문단 안에 del(빠진 말) · add(더해진 말)가 이어 붙음
    rows: { key: string; parts: Part[] }[] | null
  }[]
  callSections: PromptView['sections'] | null // 반영 전 띠 토글 '통화에 쓰는 내용' — 읽기만
  canEdit: boolean // 그 자리에서 고치기 — 관리 권한
}

// 칸마다 따로 비교 — 한 칸의 줄이 다른 칸 줄과 짝지어지지 않게. before → v (before가 없으면 비교 없음)
function promptSections(v: PersonaVersion, before?: PersonaVersion) {
  const sections = PROMPT_SECTIONS.map((s) => {
    let rows: { key: string; parts: Part[] }[] | null = null
    // 안 바뀐 칸은 rows 없이 → 글 그대로
    if (before && before.prompt[s.key] !== v.prompt[s.key]) {
      const d = inlineDiff(before.prompt[s.key].split('\n'), v.prompt[s.key].split('\n'))
      rows = d.blocks.map((parts, i) => ({ key: String(i), parts }))
    }
    return { ...s, text: v.prompt[s.key], rows }
  })
  return { sections }
}

/** 위 탭의 상담가들 — 통화에 사용 중인 상담가는 늘 맨 앞 (나머지는 서버가 준 순서 그대로) */
export function personaItems(
  list: Persona[],
  x: { currentSeq: number | undefined; step: BandStep; canManage: boolean },
): PersonaItem[] {
  return [...list]
    .sort((a, b) => Number(b.inUse) - Number(a.inUse))
    .map((p) => {
      // 6번 시험 중 · 시험 통과 — [삭제]는 시험 중만, [통화에 사용하기]는 띠로 옮김 (피그마 6번 줄)
      const mine = p.personaSeq === x.currentSeq
      const free = x.canManage && !p.inUse && !p.applyingVersion
      return {
        personaSeq: p.personaSeq,
        name: p.name,
        selected: mine,
        inUse: p.inUse,
        applying: p.applyingVersion
          ? `${VERSION_BADGE.PENDING.label}${p.applyError ? ', AI 반영 오류' : ''}`
          : null,
        deletable: free && !(mine && x.step === 'testing'),
        // 시험 전이어도 켬 — 누르면 시험부터 묻는 확인 창 (6번)
        canUse: free && !(mine && x.step !== null),
      }
    })
}

const statusBadges = (v: PersonaVersion) => {
  const b: Badge[] = []
  if (v.status === 'ACTIVE') b.push(VERSION_BADGE.ACTIVE)
  if (v.status === 'PENDING') b.push(VERSION_BADGE.PENDING)
  return b
}
/** 수정 기록 창 왼쪽 — 날짜별 목록 (11/13 새 안 5번, 피그마 2368:6500). 남은 초안은 기록이 아님 — 고쳐서 [저장]하면 버전이 됨 */
export function historyRows(
  all: PersonaVersion[],
  x: { head: PersonaVersion | null; picked: PersonaVersion | null; unapplied: boolean },
): HistoryRow[] {
  return all
    .filter((v) => !v.isDraft)
    .map((v) => ({
      version: v.version,
      time: fmtVersionTime(v.savedAt),
      author: v.author,
      badges: [
        ...(x.unapplied && v === x.head ? [VERSION_BADGE.UNAPPLIED] : []),
        ...statusBadges(v),
      ],
      selected: v === x.picked,
    }))
}

/** 수정 기록 창 오른쪽 — 고른 날짜 내용에서 통화에 쓰는 내용(base)과 다른 칸만 */
export function pickedView(
  picked: PersonaVersion,
  base: PersonaVersion,
  voiceLabel: (v: string) => string,
) {
  return {
    title: `${fmtVersionTime(picked.savedAt)} 내용`,
    // 이름 · 목소리가 다르면 프롬프트 칸 앞에 한 줄씩 — 프롬프트만 비교하면 이름만 바꾼 날짜가 '같습니다'로 보임
    meta: [
      ...(picked.name !== base.name ? [{ label: '이름', from: base.name, to: picked.name }] : []),
      ...(picked.voice.voice !== base.voice.voice
        ? [
            {
              label: '목소리',
              from: voiceLabel(base.voice.voice),
              to: voiceLabel(picked.voice.voice),
            },
          ]
        : []),
    ],
    changed: promptSections(picked, base).sections.filter((s) => s.rows),
  }
}

/** 가운데 프롬프트 카드 — 늘 현재 버전(viewing). callVersion = 통화에 쓰는 버전(반영 전 띠가 있을 때) */
export function promptView(
  viewing: PersonaVersion,
  x: { callVersion: PersonaVersion | null; comparing: boolean; voice: string; canEdit: boolean },
): PromptView {
  return {
    // 띠가 있으면 머리 줄 = 통화에 쓰는 버전의 저장 시각, 띠 = 고친 버전 (피그마처럼)
    time: fmtVersionTime((x.callVersion ?? viewing).savedAt),
    voice: x.voice,
    sections: promptSections(viewing).sections,
    // 토글이 '통화에 쓰는 내용'이면 그 버전 글 (읽기만)
    callSections: x.comparing && x.callVersion ? promptSections(x.callVersion).sections : null,
    canEdit: x.canEdit,
  }
}

/** 띠 — 반영 전 · 시험 중 · 반영 중 (11/13 새 안 1번). shown = 고친 내용(반영 중이면 그 버전, 아니면 현재 버전) */
export function bandView(
  step: BandStep,
  shown: PersonaVersion | null,
  x: {
    switchTo: string | null // 6번 — 통화를 넘겨받을 상담가 이름
    canApply: boolean
    canCompare: boolean
    applyError: string | null
    test: ReturnType<typeof useApplyTest>
  },
) {
  if (!step || !shown) return null
  const t = x.test
  const at = t.at ? fmtVersionTime(t.at) : ''
  return {
    step,
    // 6번 — 다른 상담가로 바꾸는 띠 문구: '통화에 쓰기 전 시험' · '다음 통화부터 친절형이 응대합니다'
    switchNote: x.switchTo === null ? null : `다음 통화부터 ${nameI(x.switchTo)} 응대합니다`,
    time: fmtVersionTime(shown.savedAt),
    author: shown.author,
    canApply: x.canApply,
    canCompare: x.canCompare,
    // 시험 중 — 시나리오 4 / 10 · 통과 3 · 실패 1 (연결 실패는 끝난 수에만)
    progress:
      step === 'testing' ? { ended: t.ended, total: t.total, pass: t.pass, fail: t.fail } : null,
    // 시험 중단 — 시나리오 4 / 10에서 멈춤 · 시작 시각
    stopped:
      step === 'stopped' && t.stopped
        ? { ended: t.ended, total: t.total, at: fmtVersionTime(t.stopped.at) }
        : null,
    // 확인 필요 — 시나리오 2개 실패 · 시험 시각 (4번)
    review: step === 'review' ? { fail: t.failed.length, at } : null,
    // 6번 시험 통과 — 시나리오 10개 모두 통과 · 시험 시각
    passed: step === 'passed' ? { total: t.total, at } : null,
    applyError: step === 'applying' ? x.applyError : null,
    error: t.startError ?? t.applyError,
  }
}
