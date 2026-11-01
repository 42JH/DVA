import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fmtClock, fmtShortDate } from '@/shared/lib/format'
import type { TagKind } from '@/shared/ui'
import { ApiError } from '@/shared/api/client'
import {
  DEFAULT_VOICE_LABEL,
  SPEED_CHOICE,
  SPEED_LABEL,
  VERSION_TAG,
  WAIT_LABEL,
  versionSummary,
} from '@/features/persona/labels'
import type { TestCallTarget } from '@/features/persona/hooks/useTestCall'
import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { lineDiff } from '@/features/persona/hooks/lineDiff'
import {
  applyLatest,
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
  canUse: boolean // [사용하기] (쓰는 중 · 대기 중이 아닐 때. 한 번도 적용 안 했으면 누르면 안내)
  lines: string[] // 'marin · 속도 보통' · '기다리기 보통'
  versionLine: string // '적용 버전 v6 · v7 저장됨' · '마지막 적용 v3' · '적용 버전 없음 · v1 저장됨'
}

/** 오른쪽 '버전 히스토리' 탭 한 칸 */
export interface VersionItem {
  version: number
  tags: { label: string; kind: TagKind }[] // 저장됨 · 적용 중 · 음성 설정
  date: string // '10.02'
  summary: string
  author: string
  selected: boolean
  canApply: boolean // [적용]은 맨 위 '저장됨'(초안 등)에만 (11/02 결정 — 지난 버전은 시험 통화만)
  testResult: string | null // '완료 · 01:12' — 시험 통화를 해 본 버전
  canApplyNow: boolean // 시험 통화를 끝낸 버전만 [적용]이 눌림 (10/31 결정)
}

/** 왼쪽 '시스템 프롬프트' 카드 */
export interface PromptView {
  tag: string // 'v7 · 저장됨' · 'v6 · 적용 중' · 'v4'
  subtitle: string // '빠른 접수형 · 10.30 김지훈'
  lines: { no: number; text: string; heading: boolean }[] // '# '로 시작하는 줄 = 굵게
  canEdit: boolean // [수정] · [음성 세부 조절] — 맨 위 버전 · 적용본을 볼 때만 (지난 버전은 보기만)
  compareLabel: string | null // 'v4와 비교' — 맨 위가 적용 안 된 새 버전(저장됨)일 때만
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
type Confirming = {
  kind: 'version' | 'persona'
  personaSeq: number
  head: { seq: number; version: number }
  draftRevision: string | null // [적용]: 초안이 있으면 확정부터 · [사용하기]: 늘 null (HEAD만 적용, 초안은 안 따라감)
  version: number // 창에 보일 번호 — 초안이면 HEAD + 1
} | null
const POLL_MS = 2000 // 적용 대기 중일 때만 다시 받는 간격 (AI 확인으로 서버 상태가 바뀌므로)
// '친절 안내형을' · '빠른 접수형을' — 이름 끝 글자의 받침으로 을/를
const hasBatchim = (name: string) => {
  const c = name.charCodeAt(name.length - 1) - 0xac00
  return c >= 0 && c < 11172 && c % 28 !== 0
}
const nameEul = (name: string) => `${name}${hasBatchim(name) ? '을' : '를'}`

const HISTORY_FIRST = 6 // 버전 히스토리는 앞 6개, 나머지는 '이전 버전 n개 더 보기'

/** 왼쪽 '버전 비교' 카드 (07_페르소나관리_버전비교) — v4 [적용 중] → v5 [저장됨]
 * 적용본 ↔ 맨 위(수정 중인 초안)만 (11/02 결정 — 고르는 드롭다운 없음) */
export interface CompareView {
  base: string // 'v6'
  baseTag: string // '적용 중' · '마지막 적용'
  target: string // 'v7'
  targetTag: string // '저장됨' · '적용 대기'
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

/** 07 페르소나 관리 훅 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31 · 11/02 규칙 · 실서버)
 * 오른쪽에서 페르소나 · 버전을 고르면 왼쪽에 그 프롬프트. 처음엔 통화에 사용 중인 페르소나의 맨 위 버전
 * [수정] = 늘 맨 위(초안이 있으면 초안, 없으면 HEAD)에서 시작 · [저장] = 초안 덮어쓰기 · [적용] = 확정 + 적용 요청 · 지난 버전은 보기 + 시험 통화 */
export function usePersonaPage() {
  const [tab, setTab] = useState<PanelTab>('persona')
  const [personaSeq, setPersonaSeq] = useState<number | null>(null) // null = 사용 중인 페르소나
  const [version, setVersion] = useState<number | null>(null) // null = 맨 위(초안 또는 HEAD)
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
  const all = versions.data ?? [] // 높은 번호가 위 (personaMap이 정렬). 초안이 있으면 맨 위
  const latest = all[0] ?? null // 수정 · 적용 · 비교의 대상
  const viewing = all.find((v) => v.version === version) ?? latest
  const applied = all.find((v) => v.version === persona?.appliedVersion) ?? null
  const testedSec = (v: number) => (persona ? tested[`${persona.personaSeq}-${v}`] : undefined)
  const testingVersion = all.find((v) => v.version === testing) ?? null
  const inUse = list.find((p) => p.inUse) ?? null
  const confirmingPersona = list.find((p) => p.personaSeq === confirming?.personaSeq) ?? null
  const apply = useMutation({
    mutationFn: (c: NonNullable<Confirming>) =>
      c.kind === 'version'
        ? applyLatest(c.personaSeq, c.head, c.draftRevision)
        : requestApply(c.personaSeq, c.head),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      setConfirming(null)
    },
  })
  const voiceName = (v: string) => v || DEFAULT_VOICE_LABEL
  const testCall: TestCallTarget | null =
    persona && testingVersion
      ? {
          personaSeq: persona.personaSeq,
          version: testingVersion.version,
          subtitle: [
            `${persona.name} v${testingVersion.version} (${VERSION_TAG[testingVersion.status]?.label ?? '지난 버전'})`,
            voiceName(testingVersion.voice.voice),
            SPEED_CHOICE[testingVersion.voice.speed],
          ].join(' · '),
        }
      : null

  // 비교: 적용본 ↔ 맨 위 (맨 위가 적용 안 된 새 버전일 때만)
  const canCompare = !!latest && !!applied && latest.version > applied.version
  const compare = (): CompareView | null => {
    if (!comparing || !persona || !canCompare) return null
    const rows = lineDiff(applied.prompt.split('\n'), latest.prompt.split('\n'))
    return {
      base: `v${applied.version}`,
      baseTag: persona.inUse ? '적용 중' : '마지막 적용',
      target: `v${latest.version}`,
      targetTag: VERSION_TAG[latest.status]?.label ?? '',
      removed: rows.filter((r) => r.kind === 'del').length,
      added: rows.filter((r) => r.kind === 'add').length,
      rows: rows.map((r, i) => ({ ...r, key: String(i), heading: r.text.startsWith('# ') })),
    }
  }

  // [수정]은 어느 버전을 보든 맨 위에서 시작 — 초안이 있으면 그 내용, 없으면 HEAD (11/02 결정)
  const editTarget: EditTarget | null =
    persona && latest
      ? {
          personaSeq: persona.personaSeq,
          personaName: persona.name,
          prompt: latest.prompt,
          voice: latest.voice,
          basedOn: persona.head.version,
          draftRevision: persona.draftRevision,
          saveTo: persona.head.version + 1,
          voiceFirst: editing === 'voice',
        }
      : null
  const canEdit = !!viewing && (viewing === latest || viewing.version === persona?.appliedVersion)

  return {
    tab,
    setTab,
    isLoading: personas.isPending || (persona !== null && versions.isPending),
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt:
      persona && viewing
        ? toPromptView(
            persona,
            viewing,
            canEdit,
            canCompare && viewing === latest ? applied.version : null,
          )
        : null,

    compare: compare(),

    // [적용](버전) · [사용하기](페르소나) → 확인 창 → 적용 요청(적용 대기) → AI가 확인하면 적용 중
    applyConfirm: ((): ApplyConfirm | null => {
      if (!confirming || !confirmingPersona) return null
      const until = inUse?.appliedVersion
        ? ` 그 전까지는 ${inUse.name} ${withI(inUse.appliedVersion)} 계속 쓰입니다.`
        : ''
      const v = confirming.version
      if (confirming.kind === 'persona')
        return {
          title: `${nameEul(confirmingPersona.name)} 통화에 쓸까요?`,
          target: `${confirmingPersona.name} · v${v} (마지막 적용)`,
          note: `진행 중인 통화가 끝나면(AI 확인 후) 이 페르소나로 응대합니다.${
            confirmingPersona.savedVersion
              ? ` 저장만 한 v${confirmingPersona.savedVersion}는 포함되지 않습니다.`
              : ''
          }${until}`,
          okLabel: '사용하기',
        }
      return {
        title: `${withEul(v)} 적용할까요?`,
        target: `${confirmingPersona.name} · v${v} (저장됨)`,
        note: `적용 대기가 되고, 진행 중인 통화가 끝나면(AI 확인 후) 이 버전으로 응대합니다.${until}`,
        okLabel: '적용',
      }
    })(),
    askApply: () => {
      apply.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
      if (persona && latest)
        setConfirming({
          kind: 'version',
          personaSeq: persona.personaSeq,
          head: persona.head,
          draftRevision: persona.draftRevision,
          version: latest.version,
        })
    },
    // [사용하기] = 그 페르소나의 적용본(HEAD)으로. 저장만 한 초안은 안 따라감 (11/02 결정 · 백엔드 activate 규칙)
    askUse: (seq: number) => {
      const p = list.find((x) => x.personaSeq === seq)
      if (!p) return
      apply.reset()
      setConfirming({
        kind: 'persona',
        personaSeq: seq,
        head: p.head,
        draftRevision: null,
        version: p.head.version,
      })
    },
    confirmApply: () => confirming && apply.mutate(confirming),
    cancelApply: () => setConfirming(null),
    isApplying: apply.isPending,
    applyError: !apply.error
      ? null
      : apply.error instanceof ApiError && apply.error.status === 409
        ? '그새 다른 관리자가 이 페르소나를 저장 · 적용했습니다. 창을 닫고 최신 버전을 확인해 주세요.'
        : '적용 요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.',

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
    // 버전 칸 [시험 통화] — 그 버전을 고르고 통화 창 (지난 버전도 가능, 11/02)
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
      applying: p.applyingVersion
        ? `v${p.applyingVersion} 적용 대기${p.applyError ? ' · AI 반영 오류' : ''}`
        : null,
      canUse: !p.inUse && !p.applyingVersion,
      lines: [
        `${voiceName(p.voice.voice)} · ${SPEED_LABEL[p.voice.speed]}`,
        WAIT_LABEL[p.voice.waitTime],
      ],
      versionLine: `${p.inUse ? '적용 버전' : '마지막 적용'} v${p.appliedVersion}${
        p.savedVersion ? ` · v${p.savedVersion} 저장됨` : ''
      }`,
    })),
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
      setShowAll(false)
      setComparing(false) // 다른 페르소나 버전끼리는 비교하지 않음
    },

    versions: (showAll ? all : all.slice(0, HISTORY_FIRST)).map((v): VersionItem => {
      const canApply = v === latest && v.status === 'SAVED'
      return {
        version: v.version,
        tags: [
          ...(VERSION_TAG[v.status] ? [VERSION_TAG[v.status]!] : []),
          ...(v.voiceOnly ? [{ label: '음성 설정', kind: 'gray' as TagKind }] : []),
        ],
        date: fmtShortDate(v.savedAt),
        summary: versionSummary(v.changes),
        author: v.author,
        selected: v.version === viewing?.version,
        canApply,
        testResult:
          testedSec(v.version) !== undefined ? `완료 · ${fmtClock(testedSec(v.version)!)}` : null,
        canApplyNow: canApply && testedSec(v.version) !== undefined,
      }
    }),
    moreVersions: showAll ? 0 : Math.max(0, all.length - HISTORY_FIRST),
    showAllVersions: () => setShowAll(true),
    // 다른 버전을 고르면 비교를 닫고 그 버전을 봄 (비교는 정해진 두 버전뿐)
    selectVersion: (v: number) => {
      setVersion(v)
      setComparing(false)
    },
  }
}

function toPromptView(
  p: Persona,
  v: PersonaVersion,
  canEdit: boolean,
  compareWith: number | null,
): PromptView {
  const tag = VERSION_TAG[v.status]
  return {
    tag: tag ? `v${v.version} · ${tag.label}` : `v${v.version}`,
    subtitle: [p.name, `${fmtShortDate(v.savedAt)} ${v.author}`.trim()].join(' · '),
    lines: v.prompt
      .split('\n')
      .map((text, i) => ({ no: i + 1, text, heading: text.startsWith('# ') })),
    canEdit,
    // 맨 위(저장됨)를 볼 때만 '적용본과 비교' — 부르는 쪽이 맨 위일 때만 compareWith를 줌
    compareLabel: compareWith !== null ? `${withGwa(compareWith)} 비교` : null,
  }
}
