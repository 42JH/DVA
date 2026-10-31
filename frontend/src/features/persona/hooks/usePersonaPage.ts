import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fmtClock, fmtShortDate } from '@/shared/lib/format'
import type { TagKind } from '@/shared/ui'
import { SPEED_CHOICE, SPEED_LABEL, VERSION_TAG, WAIT_LABEL } from '@/features/persona/labels'
import type { TestCallTarget } from '@/features/persona/hooks/useTestCall'
import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { lineDiff } from '@/features/persona/hooks/lineDiff'
import {
  personaQueries,
  requestApply,
  type Persona,
  type PersonaVersion,
} from '@/features/persona/api/personaApi'

export type PanelTab = 'persona' | 'history'

/** 오른쪽 '페르소나' 탭 한 칸 */
export interface PersonaItem {
  personaSeq: number
  name: string
  selected: boolean
  inUse: boolean // '통화에 사용 중' 태그
  applying: string | null // 'v3 적용 대기' — 통화에 쓰려고 AI 확인을 기다리는 중
  canUse: boolean // [사용하기] (쓰는 중 · 대기 중이 아니고 적용할 버전이 있을 때)
  lines: string[] // 'marin · 속도 보통' · '기다리기 보통'
  versionLine: string // '적용 버전 v6 · v7 저장됨' · '적용 버전 없음 · v1 저장됨'
}

/** 오른쪽 '버전 히스토리' 탭 한 칸 */
export interface VersionItem {
  version: number
  tags: { label: string; kind: TagKind }[] // 저장됨 · 적용 중 · 음성 설정
  date: string // '10.02'
  summary: string
  author: string
  selected: boolean
  canApply: boolean // 적용 중 · 적용 대기인 버전은 [적용] 없음
  testResult: string | null // '완료 · 01:12' — 시험 통화를 해 본 버전
  canApplyNow: boolean // 시험 통화를 끝낸 버전만 [적용]이 눌림 (10/31 결정)
}

/** 왼쪽 '시스템 프롬프트' 카드 */
export interface PromptView {
  tag: string // 'v7 · 저장됨' · 'v6 · 적용 중' · 'v4'
  subtitle: string // '빠른 접수형 · 10.30 김지훈 · v6에서 시작'
  lines: { no: number; text: string; heading: boolean }[] // '# '로 시작하는 줄 = 굵게
  compareLabel: string | null // 'v6과 비교' — 적용 중인 버전을 볼 때는 없음
}

// 'v6과' · 'v5와' — 숫자를 읽은 소리의 받침으로 조사를 고름 (영·일·삼·육·칠·팔 = 받침 있음)
const withGwa = (n: number) => `v${n}${'013678'.includes(String(n).slice(-1)) ? '과' : '와'}`
const withEul = (n: number) => `v${n}${'013678'.includes(String(n).slice(-1)) ? '을' : '를'}` // 'v7을' · 'v5를'
const withI = (n: number) => `v${n}${'013678'.includes(String(n).slice(-1)) ? '이' : '가'}` // 'v6이' · 'v5가'

/** [적용] · [사용하기] 확인 창 문구 */
export interface ApplyConfirm {
  title: string // 'v7을 적용할까요?' · '친절 안내형을 통화에 쓸까요?'
  target: string // '빠른 접수형 · v7 (저장됨)'
  note: string
  okLabel: string // '적용' · '사용하기'
}
type Confirming = { kind: 'version' | 'persona'; personaSeq: number; version: number } | null
const POLL_MS = 2000 // 적용 대기 중일 때만 다시 받는 간격 (AI 확인으로 서버 상태가 바뀌므로)
// '친절 안내형을' · '빠른 접수형을' — 이름 끝 글자의 받침으로 을/를
const nameEul = (name: string) => {
  const c = name.charCodeAt(name.length - 1) - 0xac00
  return `${name}${c >= 0 && c < 11172 && c % 28 !== 0 ? '을' : '를'}`
}

const HISTORY_FIRST = 6 // 버전 히스토리는 앞 6개, 나머지는 '이전 버전 n개 더 보기'

/** 왼쪽 '버전 비교' 카드 (07_페르소나관리_버전비교) — v6 [적용 중] → [v8 ▾]
 * 기준은 늘 그 페르소나의 적용 버전(통화에 안 쓰는 페르소나면 마지막으로 적용했던 버전), 드롭다운 = 지금 보는 버전 (10/31 결정) */
export interface CompareView {
  base: string // 'v6' — 고정
  baseTag: string // '적용 중' · '마지막 적용'
  options: { value: string; label: string }[] // 기준을 뺀 모든 버전
  target: string // 드롭다운 값 = 지금 보는 버전 번호
  removed: number // '빠진 줄 2'
  added: number // '더한 줄 3'
  rows: {
    key: string
    kind: 'same' | 'del' | 'add'
    from: number | null
    to: number | null
    text: string
    heading: boolean
  }[]
}

/** 07 페르소나 관리 훅 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31)
 * 오른쪽에서 페르소나 · 버전을 고르면 왼쪽에 그 프롬프트. 처음엔 통화에 사용 중인 페르소나의 최신 버전(저장됨이 있으면 그것)
 * [수정] = 지금 보는 버전에서 시작, 화면엔 바로 '가장 큰 번호 + 1 · 작성 중' (저장해야 그 번호로 서버에 생김, 10/31 결정) */
export function usePersonaPage() {
  const [tab, setTab] = useState<PanelTab>('persona')
  const [personaSeq, setPersonaSeq] = useState<number | null>(null) // null = 사용 중인 페르소나
  const [version, setVersion] = useState<number | null>(null) // null = 맨 위(저장됨 또는 적용 중)
  const [showAll, setShowAll] = useState(false)
  const [editing, setEditing] = useState<false | 'prompt' | 'voice'>(false) // 수정 화면 (voice = 음성 창부터 열고 들어옴)
  const [comparing, setComparing] = useState(false) // 왼쪽 카드 = 버전 비교
  const [testing, setTesting] = useState<number | null>(null) // 시험 통화 중인 버전
  // 시험 통화 결과 '페르소나-버전' → 걸린 초. shortcut: 시험 통화 API가 없어 화면에만 기억(새로고침하면 사라짐) — BE가 기록을 주면 그걸로
  const [tested, setTested] = useState<Record<string, number>>({})
  const [confirming, setConfirming] = useState<Confirming>(null) // [적용] · [사용하기] 확인 창
  const [adding, setAdding] = useState(false) // 페르소나 추가 창
  const qc = useQueryClient()

  const personas = useQuery({
    ...personaQueries.list(),
    refetchInterval: (q) => (q.state.data?.some((p) => p.applyingVersion) ? POLL_MS : false),
  })
  const list = personas.data ?? []
  const persona =
    list.find((p) => p.personaSeq === personaSeq) ?? list.find((p) => p.inUse) ?? list[0] ?? null
  const versions = useQuery({
    ...personaQueries.versions(persona?.personaSeq ?? 0),
    enabled: persona !== null,
    refetchInterval: (q) => (q.state.data?.some((v) => v.status === 'PENDING') ? POLL_MS : false),
  })
  // 높은 번호가 위 — 히스토리 · 비교 드롭다운 · 처음 보는 버전(all[0])이 모두 이 순서에 기댐. 서버 응답 순서를 믿지 않고 여기서 정렬
  const all = [...(versions.data ?? [])].sort((a, b) => b.version - a.version)
  const viewing = all.find((v) => v.version === version) ?? all[0] ?? null
  const testedSec = (v: number) => (persona ? tested[`${persona.personaSeq}-${v}`] : undefined)
  const testingVersion = all.find((v) => v.version === testing) ?? null
  const inUse = list.find((p) => p.inUse) ?? null
  const confirmingPersona = list.find((p) => p.personaSeq === confirming?.personaSeq) ?? null
  const confirmingVersion =
    confirming?.kind === 'version'
      ? (all.find((v) => v.version === confirming.version) ?? null)
      : null
  const apply = useMutation({
    mutationFn: (c: NonNullable<Confirming>) => requestApply(c.personaSeq, c.version),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      setConfirming(null)
    },
  })
  const testCall: TestCallTarget | null =
    persona && testingVersion
      ? {
          personaSeq: persona.personaSeq,
          version: testingVersion.version,
          subtitle: [
            `${persona.name} v${testingVersion.version} (${VERSION_TAG[testingVersion.status]?.label ?? '지난 버전'})`,
            testingVersion.voice.voice,
            SPEED_CHOICE[testingVersion.voice.speed],
          ].join(' · '),
        }
      : null

  // 비교: 앞 = 적용 버전(고정), 뒤 = 지금 보는 버전. 드롭다운 · 히스토리 클릭 모두 '지금 보는 버전'(version)을 바꿈 → 둘이 늘 같음
  const base = all.find((v) => v.version === persona?.activeVersion) ?? null
  const compare = (): CompareView | null => {
    if (!comparing || !persona || !viewing || !base || viewing === base) return null
    const rows = lineDiff(base.prompt.split('\n'), viewing.prompt.split('\n'))
    return {
      base: `v${base.version}`,
      baseTag: persona.inUse ? '적용 중' : '마지막 적용',
      options: all
        .filter((v) => v !== base)
        .map((v) => ({ value: String(v.version), label: `v${v.version}` })),
      target: String(viewing.version),
      removed: rows.filter((r) => r.kind === 'del').length,
      added: rows.filter((r) => r.kind === 'add').length,
      rows: rows.map((r, i) => ({ ...r, key: String(i), heading: r.text.startsWith('# ') })),
    }
  }

  const editTarget: EditTarget | null =
    persona && viewing
      ? {
          personaSeq: persona.personaSeq,
          personaName: persona.name,
          prompt: viewing.prompt,
          voice: viewing.voice,
          basedOn: viewing.version,
          saveTo: Math.max(0, ...all.map((v) => v.version)) + 1,
          voiceFirst: editing === 'voice',
        }
      : null

  return {
    tab,
    setTab,
    isLoading: personas.isPending || (persona !== null && versions.isPending),
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt: persona && viewing ? toPromptView(persona, viewing) : null,

    compare: compare(),

    // [적용](버전) · [사용하기](페르소나) → 확인 창 → 적용 요청(적용 대기) → AI가 확인하면 적용 중
    applyConfirm: ((): ApplyConfirm | null => {
      if (!confirming || !confirmingPersona) return null
      const until = inUse?.activeVersion
        ? ` 그 전까지는 ${inUse.name} ${withI(inUse.activeVersion)} 계속 쓰입니다.`
        : ''
      if (confirming.kind === 'persona')
        return {
          title: `${nameEul(confirmingPersona.name)} 통화에 쓸까요?`,
          target: `${confirmingPersona.name} · v${confirming.version}`,
          note: `진행 중인 통화가 끝나면(AI 확인 후) 이 페르소나로 응대합니다.${until}`,
          okLabel: '사용하기',
        }
      return {
        title: `${withEul(confirming.version)} 적용할까요?`,
        target: `${confirmingPersona.name} · v${confirming.version} (${(confirmingVersion && VERSION_TAG[confirmingVersion.status]?.label) ?? '지난 버전'})`,
        note: `적용 대기가 되고, 진행 중인 통화가 끝나면(AI 확인 후) 이 버전으로 응대합니다.${until}`,
        okLabel: '적용',
      }
    })(),
    askApply: (v: number) => {
      apply.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
      if (persona) setConfirming({ kind: 'version', personaSeq: persona.personaSeq, version: v })
    },
    askUse: (seq: number) => {
      const p = list.find((x) => x.personaSeq === seq)
      const v = p?.activeVersion ?? p?.savedVersion // 그 페르소나의 적용 버전 (한 번도 적용 안 했으면 최신 저장본)
      apply.reset()
      if (p && v) setConfirming({ kind: 'persona', personaSeq: seq, version: v })
    },
    confirmApply: () => confirming && apply.mutate(confirming),
    cancelApply: () => setConfirming(null),
    isApplying: apply.isPending,
    applyError: apply.error?.message ?? null,

    adding,
    openAdd: () => setAdding(true),
    closeAdd: () => setAdding(false),
    // 추가하면 그 페르소나를 골라 보여 줌
    added: (seq: number) => {
      setAdding(false)
      setPersonaSeq(seq)
      setVersion(null)
      setTab('persona')
    },

    testCall,
    // 버전 칸 [시험 통화] — 그 버전을 고르고 통화 창
    startTestCall: (v: number) => {
      setVersion(v)
      setTesting(v)
    },
    endTestCall: (seconds: number) => {
      if (persona && testing !== null)
        setTested((t) => ({ ...t, [`${persona.personaSeq}-${testing}`]: seconds }))
      setTesting(null)
    },
    startCompare: () => setComparing(true),
    // 드롭다운으로 앞 6개 밖의 옛 버전을 고르면 히스토리를 펼쳐 선택 칸이 보이게 ('더 보기'를 누른 것과 같음)
    setCompareTarget: (v: string) => {
      const n = Number(v)
      setVersion(n)
      if (!all.slice(0, HISTORY_FIRST).some((x) => x.version === n)) setShowAll(true)
    },
    closeCompare: () => setComparing(false),

    editing: editing !== false,
    editTarget,
    startEdit: () => {
      setComparing(false)
      setEditing('prompt')
    },
    // 보기 화면 [음성 세부 조절] = 음성만 바꿔도 새 버전이라 수정 화면으로 들어가며 음성 창을 엶
    startVoice: () => {
      setComparing(false)
      setEditing('voice')
    },
    // 저장하면 새로 생긴 버전을 보여 줌 (취소면 보던 버전 그대로)
    finishEdit: (savedVersion?: number) => {
      setEditing(false)
      if (savedVersion !== undefined) setVersion(savedVersion)
    },

    personas: list.map((p): PersonaItem => ({
      personaSeq: p.personaSeq,
      name: p.name,
      selected: p.personaSeq === persona?.personaSeq,
      inUse: p.inUse,
      applying: p.applyingVersion ? `v${p.applyingVersion} 적용 대기` : null,
      canUse: !p.inUse && !p.applyingVersion && (p.activeVersion ?? p.savedVersion) !== null,
      lines: [`${p.voice.voice} · ${SPEED_LABEL[p.voice.speed]}`, WAIT_LABEL[p.voice.waitTime]],
      versionLine: `${p.activeVersion ? `적용 버전 v${p.activeVersion}` : '적용 버전 없음'}${p.savedVersion ? ` · v${p.savedVersion} 저장됨` : ''}`,
    })),
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
      setShowAll(false)
      setComparing(false) // 다른 페르소나 버전끼리는 비교하지 않음
    },

    versions: (showAll ? all : all.slice(0, HISTORY_FIRST)).map((v): VersionItem => ({
      version: v.version,
      tags: [
        ...(VERSION_TAG[v.status] ? [VERSION_TAG[v.status]!] : []),
        ...(v.voiceOnly ? [{ label: '음성 설정', kind: 'gray' as TagKind }] : []),
      ],
      date: fmtShortDate(v.savedAt),
      summary: v.summary,
      author: v.author,
      selected: v.version === viewing?.version,
      canApply: v.status !== 'ACTIVE' && v.status !== 'PENDING',
      testResult:
        testedSec(v.version) !== undefined ? `완료 · ${fmtClock(testedSec(v.version)!)}` : null,
      canApplyNow:
        v.status !== 'ACTIVE' && v.status !== 'PENDING' && testedSec(v.version) !== undefined,
    })),
    moreVersions: showAll ? 0 : Math.max(0, all.length - HISTORY_FIRST),
    showAllVersions: () => setShowAll(true),
    // 비교 중에 적용 버전을 누르면 자기 자신과 비교가 되므로 비교를 닫고 그 버전을 봄
    selectVersion: (v: number) => {
      setVersion(v)
      if (v === persona?.activeVersion) setComparing(false)
    },
  }
}

function toPromptView(p: Persona, v: PersonaVersion): PromptView {
  const tag = VERSION_TAG[v.status]
  return {
    tag: tag ? `v${v.version} · ${tag.label}` : `v${v.version}`,
    subtitle: [
      p.name,
      `${fmtShortDate(v.savedAt)} ${v.author}`,
      v.basedOn !== null && `v${v.basedOn}에서 시작`,
    ]
      .filter(Boolean)
      .join(' · '),
    lines: v.prompt
      .split('\n')
      .map((text, i) => ({ no: i + 1, text, heading: text.startsWith('# ') })),
    compareLabel:
      p.activeVersion === null || v.version === p.activeVersion
        ? null
        : `${withGwa(p.activeVersion)} 비교`,
  }
}
