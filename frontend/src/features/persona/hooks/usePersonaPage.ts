import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fmtShortDate } from '@/shared/lib/format'
import { ApiError } from '@/shared/api/client'
import { useSession } from '@/shared/auth/useSession'
import {
  DEFAULT_VOICE_LABEL,
  PROMPT_SECTIONS,
  SPEED_CHOICE,
  SPEED_LABEL,
  VERSION_TAG,
  WAIT_LABEL,
} from '@/features/persona/labels'
import type { TestCallTarget } from '@/features/persona/hooks/useTestCall'
import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { lineDiff } from '@/features/persona/hooks/lineDiff'
import {
  applyLatest,
  PERSONA_DEMO,
  personaQueries,
  requestApply,
  type Persona,
  type PersonaVersion,
  type PromptKey,
} from '@/features/persona/api/personaApi'

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
  history: PersonaHistory | null // 고른 카드에만 — 버전 목록은 고른 상담가 것만 불러옴 (11/10)
}

/** 고른 카드의 히스토리 드롭다운 + [시험 통화] · [적용] (11/10 — 버전 기록 목록 대신) */
interface PersonaHistory {
  options: { value: string; label: string }[] // 'v7 · 저장됨 · 11.09' (높은 번호가 위)
  value: string // 보고 있는 버전
  canApply: boolean // [적용]은 맨 위 '저장됨'(초안 등)을 볼 때만 (11/02 결정 — 지난 버전은 시험 통화만)
  canApplyNow: boolean // 시험 통화를 끝낸 버전만 [적용]이 눌림 (10/31 결정)
}

/** 왼쪽 '시스템 프롬프트' 카드 */
interface PromptView {
  tag: string // 'v7 · 저장됨' · 'v6 · 적용 중' · 'v4'
  subtitle: string // '빠른 접수형 · 10.30 김지훈'
  sections: { key: PromptKey; group: string | null; sub: boolean; title: string; text: string }[] // 고정 제목 + 본문(마크다운)
  canEdit: boolean // [수정] · [음성 세부 조절] — 맨 위 버전 · 적용본을 볼 때만 (지난 버전은 보기만)
  compareLabel: string | null // 'v4와 비교' — 맨 위가 적용 안 된 새 버전(저장됨)일 때만
}

// 'v6과' · 'v5와' — 숫자를 읽은 소리의 받침으로 조사를 고름 (영·일·삼·육·칠·팔 = 받침 있음)
const withGwa = (n: number) => `v${n}${'013678'.includes(String(n).slice(-1)) ? '과' : '와'}`
const withEul = (n: number) => `v${n}${'013678'.includes(String(n).slice(-1)) ? '을' : '를'}` // 'v7을' · 'v5를'
const withI = (n: number) => `v${n}${'013678'.includes(String(n).slice(-1)) ? '이' : '가'}` // 'v6이' · 'v5가'

/** [적용] · [사용하기] 확인 창 문구 */
interface ApplyConfirm {
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

const PANEL_KEY = 'dva.persona.panel' // 오른쪽 패널을 접어 뒀는지 — 보기 · 수정 화면 공용, 이 브라우저에만 ('closed' = 접힘)
const loadPanelOpen = () => {
  try {
    return localStorage.getItem(PANEL_KEY) !== 'closed'
  } catch {
    return true // 저장소가 막혀 있으면 펼친 채로
  }
}

/** 왼쪽 '버전 비교' 카드 (07_페르소나관리_버전비교) — v4 [적용 중] → v5 [저장됨]
 * 적용본 ↔ 맨 위(수정 중인 초안)만 (11/02 결정 — 고르는 드롭다운 없음) */
interface CompareView {
  base: string // 'v6'
  baseTag: string // '적용 중' · '마지막 적용'
  target: string // 'v7'
  targetTag: string // '저장됨' · '적용 대기'
  removed: number // '빠진 줄 2' — 여섯 칸 합
  added: number // '더한 줄 3'
  sections: {
    key: PromptKey
    group: string | null
    sub: boolean
    title: string
    changed: boolean // 이 칸에 빠진 줄 · 더한 줄이 있음
    rows: {
      key: string
      kind: 'same' | 'del' | 'add'
      from: number | null // 줄 번호는 칸 안에서 1부터
      to: number | null
      text: string
    }[]
  }[]
}

/** 07 페르소나 관리 훅 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31 · 11/02 규칙 · 실서버)
 * 오른쪽에서 페르소나 · 버전을 고르면 왼쪽에 그 프롬프트. 처음엔 통화에 사용 중인 페르소나의 맨 위 버전
 * [수정] = 늘 맨 위(초안이 있으면 초안, 없으면 HEAD)에서 시작 · [저장] = 초안 덮어쓰기 · [적용] = 확정 + 적용 요청 · 지난 버전은 보기 + 시험 통화 */
export function usePersonaPage() {
  const [personaSeq, setPersonaSeq] = useState<number | null>(null) // null = 사용 중인 페르소나
  const [version, setVersion] = useState<number | null>(null) // null = 맨 위(초안 또는 HEAD)
  const [editing, setEditing] = useState<false | 'prompt' | 'voice'>(false) // 수정 화면 (voice = 음성 창부터 열고 들어옴)
  const [comparing, setComparing] = useState(false) // 왼쪽 카드 = 버전 비교
  const [testing, setTesting] = useState<number | null>(null) // 시험 통화 중인 버전
  // 시험 통화 결과 '페르소나-버전' → 걸린 초. shortcut: 시험 통화 API가 없어 화면에만 기억(새로고침하면 사라짐) — BE가 기록을 주면 그걸로
  const [tested, setTested] = useState<Record<string, number>>({})
  const [confirming, setConfirming] = useState<Confirming>(null) // [적용] · [사용하기] 확인 창
  const [adding, setAdding] = useState(false) // 페르소나 추가 창
  const [panelOpen, setPanelOpen] = useState(loadPanelOpen) // 오른쪽 패널 — 보기 · 수정 화면이 같은 값 (처음엔 펼침, 접으면 기억)
  const qc = useQueryClient()
  // 추가 · 수정 · 적용 · 사용하기는 SUPERVISOR · SYSTEM_ADMIN만 (백엔드 persona-head-management.md) → OPERATOR는 버튼을 숨기고 보기 · 시험 통화만 (11/02 사용자)
  // 내 정보를 불러오기 전(role undefined)에도 숨김
  const { role } = useSession()
  const canManage = role === 'SUPERVISOR' || role === 'SYSTEM_ADMIN'

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
    // 칸마다 따로 비교 — 한 칸의 줄이 다른 칸 줄과 짝지어지지 않게 (11/10 칸별 비교)
    const sections = PROMPT_SECTIONS.map((s) => {
      const rows = lineDiff(applied.prompt[s.key].split('\n'), latest.prompt[s.key].split('\n'))
      return {
        ...s,
        changed: rows.some((r) => r.kind !== 'same'),
        rows: rows.map((r, i) => ({ ...r, key: String(i) })),
      }
    })
    const count = (kind: 'del' | 'add') =>
      sections.reduce((n, s) => n + s.rows.filter((r) => r.kind === kind).length, 0)
    return {
      base: `v${applied.version}`,
      baseTag: persona.inUse ? '적용 중' : '마지막 적용',
      target: `v${latest.version}`,
      targetTag: VERSION_TAG[latest.status]?.label ?? '',
      removed: count('del'),
      added: count('add'),
      sections,
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
  const canEdit =
    canManage && !!viewing && (viewing === latest || viewing.version === persona?.appliedVersion)

  // [수정] · [음성 세부 조절]: 패널이 버전 히스토리의 맨 위(초안이 있으면 초안 = 지금 고치는 것)를 가리키게 (11/02 사용자)
  const beginEdit = (mode: 'prompt' | 'voice') => {
    setComparing(false)
    setVersion(null)
    setEditing(mode)
  }

  const history = (v: PersonaVersion): PersonaHistory => {
    const canApply = canManage && v === latest && v.status === 'SAVED'
    return {
      options: all.map((x) => ({
        value: String(x.version),
        label: [`v${x.version}`, VERSION_TAG[x.status]?.label, fmtShortDate(x.savedAt)]
          .filter(Boolean)
          .join(' · '),
      })),
      value: String(v.version),
      canApply,
      canApplyNow: canApply && testedSec(v.version) !== undefined,
    }
  }

  return {
    demo: PERSONA_DEMO, // 시연 모드 — 저장 · 적용이 실서버에 안 감
    isLoading: personas.isPending, // 처음 들어올 때만 화면 전체
    // 상담가를 바꿀 때 버전을 받는 동안은 가운데만 — 오른쪽 카드가 다시 그려지면 스크롤이 맨 위로 감 (11/10)
    promptLoading: persona !== null && versions.isPending,
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
    canAdd: canManage,
    openAdd: () => setAdding(true),
    closeAdd: () => setAdding(false),
    // 추가하면 그 페르소나를 골라 보여 줌
    added: (seq: number) => {
      setAdding(false)
      setPersonaSeq(seq)
      setVersion(null)
    },

    testCall,
    // 카드 [시험 통화] — 드롭다운에서 보고 있는 버전으로 (지난 버전도 가능, 11/02)
    startTestCall: () => viewing && setTesting(viewing.version),
    endTestCall: (seconds: number) => {
      if (persona && testing !== null)
        setTested((t) => ({ ...t, [`${persona.personaSeq}-${testing}`]: seconds }))
      setTesting(null)
    },
    startCompare: () => setComparing(true),
    closeCompare: () => setComparing(false),

    editing: editing !== false,
    panelOpen,
    togglePanel: () => {
      const next = !panelOpen
      setPanelOpen(next)
      try {
        localStorage.setItem(PANEL_KEY, next ? 'open' : 'closed')
      } catch {
        // 못 저장해도 이번 화면에선 바뀜
      }
    },
    editTarget,
    startEdit: () => beginEdit('prompt'),
    // 보기 화면 [음성 세부 조절] = 음성만 바꿔도 새 버전이라 수정 화면으로 들어가며 음성 창을 엶
    startVoice: () => beginEdit('voice'),
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
      canUse: canManage && !p.inUse && !p.applyingVersion,
      lines: [
        `${voiceName(p.voice.voice)} · ${SPEED_LABEL[p.voice.speed]}`,
        WAIT_LABEL[p.voice.waitTime],
      ],
      versionLine: `${p.inUse ? '적용 버전' : '마지막 적용'} v${p.appliedVersion}${
        p.savedVersion ? ` · v${p.savedVersion} 저장됨` : ''
      }`,
      history: p.personaSeq === persona?.personaSeq && viewing ? history(viewing) : null,
    })),
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
      setComparing(false) // 다른 페르소나 버전끼리는 비교하지 않음
    },
    // 다른 버전을 고르면 비교를 닫고 그 버전을 봄 (비교는 정해진 두 버전뿐)
    selectVersion: (v: string) => {
      setVersion(Number(v)) // 드롭다운 값은 문자열
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
    sections: PROMPT_SECTIONS.map((s) => ({ ...s, text: v.prompt[s.key] })),
    canEdit,
    // 맨 위(저장됨)를 볼 때만 '적용본과 비교' — 부르는 쪽이 맨 위일 때만 compareWith를 줌
    compareLabel: compareWith !== null ? `${withGwa(compareWith)} 비교` : null,
  }
}
