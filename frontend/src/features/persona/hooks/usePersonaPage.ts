import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { fmtShortDate } from '@/shared/lib/format'
import type { TagKind } from '@/shared/ui'
import { SPEED_LABEL, VERSION_TAG, WAIT_LABEL } from '@/features/persona/labels'
import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { lineDiff } from '@/features/persona/hooks/lineDiff'
import {
  personaQueries,
  type Persona,
  type PersonaVersion,
} from '@/features/persona/api/personaApi'

export type PanelTab = 'persona' | 'history'

/** 오른쪽 '페르소나' 탭 한 칸 */
export interface PersonaItem {
  personaSeq: number
  name: string
  selected: boolean
  inUse: boolean // '통화에 사용 중' 태그 (아니면 [사용하기])
  lines: string[] // 'marin · 속도 보통' · '기다리기 보통'
  versionLine: string // '적용 버전 v6 · v7 저장됨'
}

/** 오른쪽 '버전 히스토리' 탭 한 칸 */
export interface VersionItem {
  version: number
  tags: { label: string; kind: TagKind }[] // 저장됨 · 적용 중 · 음성 설정
  date: string // '10.02'
  summary: string
  author: string
  selected: boolean
  canApply: boolean // 적용 중인 버전은 [적용] 없음 (이미 통화에 쓰는 중)
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

const HISTORY_FIRST = 6 // 버전 히스토리는 앞 6개, 나머지는 '이전 버전 n개 더 보기'

/** 왼쪽 '버전 비교' 카드 (07_페르소나관리_버전비교) — [v6 ▾] → 지금 보는 버전 */
export interface CompareView {
  fromOptions: { value: string; label: string }[] // 적용 중인 버전이 맨 앞 (기본값)
  from: string
  to: string // 'v7'
  toTag: string | null // '최신' · '적용 중' · '저장됨'
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
  const [editing, setEditing] = useState(false) // 수정 화면 (오른쪽 패널 없이 넓게)
  const [comparing, setComparing] = useState(false) // 왼쪽 카드 = 버전 비교
  const [compareFrom, setCompareFrom] = useState<number | null>(null) // null = 적용 중인 버전

  const personas = useQuery(personaQueries.list())
  const list = personas.data ?? []
  const persona =
    list.find((p) => p.personaSeq === personaSeq) ?? list.find((p) => p.inUse) ?? list[0] ?? null
  const versions = useQuery({
    ...personaQueries.versions(persona?.personaSeq ?? 0),
    enabled: persona !== null,
  })
  const all = versions.data ?? []
  const viewing = all.find((v) => v.version === version) ?? all[0] ?? null

  // 비교: 앞 = 고른 버전(기본 적용 중), 뒤 = 지금 보는 버전. 히스토리에서 다른 버전을 누르면 뒤가 바뀜
  const others = all.filter((v) => v.version !== viewing?.version)
  const fromOptions = [
    ...others.filter((v) => v.status === 'ACTIVE'),
    ...others.filter((v) => v.status !== 'ACTIVE'),
  ]
  const from = fromOptions.find((v) => v.version === compareFrom) ?? fromOptions[0] ?? null
  const compare = (): CompareView | null => {
    if (!comparing || !viewing || !from) return null
    const rows = lineDiff(from.prompt.split('\n'), viewing.prompt.split('\n'))
    const latest = viewing.version === Math.max(...all.map((v) => v.version))
    return {
      fromOptions: fromOptions.map((v) => ({ value: String(v.version), label: `v${v.version}` })),
      from: String(from.version),
      to: `v${viewing.version}`,
      toTag: latest ? '최신' : (VERSION_TAG[viewing.status]?.label ?? null),
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
          basedOn: viewing.version,
          saveTo: Math.max(0, ...all.map((v) => v.version)) + 1,
        }
      : null

  return {
    tab,
    setTab,
    isLoading: personas.isPending || (persona !== null && versions.isPending),
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt: persona && viewing ? toPromptView(persona, viewing) : null,

    compare: compare(),
    startCompare: () => {
      setCompareFrom(null)
      setComparing(true)
    },
    setCompareFrom: (v: string) => setCompareFrom(Number(v)),
    closeCompare: () => setComparing(false),

    editing,
    editTarget,
    startEdit: () => {
      setComparing(false)
      setEditing(true)
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
      lines: [`${p.voice} · ${SPEED_LABEL[p.speed]}`, WAIT_LABEL[p.waitTime]],
      versionLine: `적용 버전 v${p.activeVersion}${p.pendingVersion ? ` · v${p.pendingVersion} 저장됨` : ''}`,
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
      canApply: v.status !== 'ACTIVE',
    })),
    moreVersions: showAll ? 0 : Math.max(0, all.length - HISTORY_FIRST),
    showAllVersions: () => setShowAll(true),
    selectVersion: setVersion,
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
    compareLabel: v.version === p.activeVersion ? null : `${withGwa(p.activeVersion)} 비교`,
  }
}
