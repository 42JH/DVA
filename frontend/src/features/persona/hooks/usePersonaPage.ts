import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { fmtShortDate } from '@/shared/lib/format'
import type { TagKind } from '@/shared/ui'
import { SPEED_LABEL, VERSION_TAG, WAIT_LABEL } from '@/features/persona/labels'
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
  versionLine: string // '적용 버전 v6 · v7 작성 중'
}

/** 오른쪽 '버전 히스토리' 탭 한 칸 */
export interface VersionItem {
  version: number
  tags: { label: string; kind: TagKind }[] // 작성 중 · 적용 중 · 음성 설정
  date: string // '10.02' · '저장 전'
  summary: string
  author: string | null
  selected: boolean
  isDraft: boolean // [시험 통화] [적용] 자리
}

/** 왼쪽 '시스템 프롬프트' 카드 */
export interface PromptView {
  tag: string // 'v7 · 작성 중' · 'v6 · 적용 중' · 'v4'
  subtitle: string // '빠른 접수형 · 적용 버전 v6에서 시작'
  lines: { no: number; text: string; heading: boolean }[] // '# '로 시작하는 줄 = 굵게
  isDraft: boolean
  compareLabel: string | null // 'v6과 비교' — 적용 중인 버전을 볼 때는 없음
}

// 'v6과' · 'v5와' — 숫자를 읽은 소리의 받침으로 조사를 고름 (영·일·삼·육·칠·팔 = 받침 있음)
const withGwa = (n: number) => `v${n}${'013678'.includes(String(n).slice(-1)) ? '과' : '와'}`

const HISTORY_FIRST = 6 // 버전 히스토리는 앞 6개, 나머지는 '이전 버전 n개 더 보기'

/** 07 페르소나 관리 훅 (와이어프레임 07_페르소나관리 · _버전히스토리, 10/31)
 * 오른쪽에서 페르소나 · 버전을 고르면 왼쪽에 그 프롬프트. 처음엔 통화에 사용 중인 페르소나의 최신 버전(작성 중이 있으면 그것) */
export function usePersonaPage() {
  const [tab, setTab] = useState<PanelTab>('persona')
  const [personaSeq, setPersonaSeq] = useState<number | null>(null) // null = 사용 중인 페르소나
  const [version, setVersion] = useState<number | null>(null) // null = 맨 위(작성 중 또는 적용 중)
  const [showAll, setShowAll] = useState(false)

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

  return {
    tab,
    setTab,
    isLoading: personas.isPending || (persona !== null && versions.isPending),
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt: persona && viewing ? toPromptView(persona, viewing) : null,

    personas: list.map((p): PersonaItem => ({
      personaSeq: p.personaSeq,
      name: p.name,
      selected: p.personaSeq === persona?.personaSeq,
      inUse: p.inUse,
      lines: [`${p.voice} · ${SPEED_LABEL[p.speed]}`, WAIT_LABEL[p.waitTime]],
      versionLine: `적용 버전 v${p.activeVersion}${p.draftVersion ? ` · v${p.draftVersion} 작성 중` : ''}`,
    })),
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
      setShowAll(false)
    },

    versions: (showAll ? all : all.slice(0, HISTORY_FIRST)).map((v): VersionItem => ({
      version: v.version,
      tags: [
        ...(VERSION_TAG[v.status] ? [VERSION_TAG[v.status]!] : []),
        ...(v.voiceOnly ? [{ label: '음성 설정', kind: 'gray' as TagKind }] : []),
      ],
      date: v.savedAt ? fmtShortDate(v.savedAt) : '저장 전',
      summary: v.summary,
      author: v.author,
      selected: v.version === viewing?.version,
      isDraft: v.status === 'DRAFT',
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
    subtitle:
      v.status === 'DRAFT'
        ? `${p.name} · 적용 버전 v${v.basedOn ?? p.activeVersion}에서 시작`
        : [p.name, v.savedAt && fmtShortDate(v.savedAt), v.author].filter(Boolean).join(' · '),
    lines: v.prompt
      .split('\n')
      .map((text, i) => ({ no: i + 1, text, heading: text.startsWith('# ') })),
    isDraft: v.status === 'DRAFT',
    compareLabel: v.version === p.activeVersion ? null : `${withGwa(p.activeVersion)} 비교`,
  }
}
