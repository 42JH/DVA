import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { fmtVersionTime } from '@/shared/lib/format'
import { ApiError } from '@/shared/api/client'
import { useSession } from '@/shared/auth/useSession'
import type { Tone } from '@/shared/ui'
import {
  DEFAULT_VOICE_LABEL,
  PROMPT_SECTIONS,
  unsupportedText,
  VERSION_BADGE,
} from '@/features/persona/labels'
import type { TestCallTarget } from '@/features/persona/hooks/useTestCall'
import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { inlineDiff, type Part } from '@/features/persona/hooks/lineDiff'
import { useVoiceOptions } from '@/features/persona/hooks/useVoiceOptions'
import {
  ConfirmError,
  deletePersona,
  PERSONA_DEMO,
  personaQueries,
  PROMPT_KEYS,
  requestApply,
  saveVersion,
  type PersonaVersion,
  type PromptKey,
} from '@/features/persona/api/personaApi'

/** 오른쪽 상담가 카드 한 장 */
export interface PersonaItem {
  personaSeq: number
  name: string
  selected: boolean
  inUse: boolean // '통화에 사용 중' 태그
  applying: string | null // '적용 대기' — 통화에 쓰려고 AI 확인을 기다리는 중
  voice: string // 'marin' — 음성 이름만
  note: string | null // '통화엔 이전 버전 사용 중' — 사용 중인 상담가에 더 새 버전이 있을 때
  useLabel: string | null // [통화에 사용하기] · [새 버전 통화에 사용하기] 문구. null = 버튼 없음
  deletable: boolean // [삭제] 버튼 — 관리 권한 + 통화에 사용 중도 적용 대기도 아닐 때만
}

type Badge = { label: string; tone: Tone }

/** 버전 기록 한 줄 (11/11 — Notion 버전 기록처럼 저장 시각 + 수정한 사람) */
export interface HistoryRow {
  version: number
  time: string // '오늘 오후 3:07'
  voice: string // 'marin' — 그 버전에 쓰인 음성 이름 (11/11)
  author: string // 모르면 ''
  badges: Badge[] // 통화에 사용 중 · 적용 대기
  selected: boolean
}

/** 가운데 프롬프트 카드 */
interface PromptView {
  time: string
  author: string
  badges: Badge[]
  sections: {
    key: PromptKey
    group: string | null
    sub: boolean
    title: string
    text: string
    // 버전 기록에서 볼 때만(가장 오래된 버전 빼고) — 바로 직전 버전 기준 비교. 한 문단 안에 del(이 버전에서 빠진 말) · add(이 버전에서 더해진 말)가 이어 붙음
    rows: { key: string; parts: Part[] }[] | null
  }[]
  canEdit: boolean // [프롬프트 수정] — 현재 버전을 볼 때만
  past: boolean // 기록에서 고른 지난 버전 → 현재 버전 기준 차이 표시 · [이 버전 다시 쓰기]
  reuse: { disabled: boolean; hint: string | undefined } | null // [이 버전 다시 쓰기] — 관리자가 지난 버전을 볼 때만
}

/** [통화에 사용하기] · [이 버전 다시 쓰기] · [삭제] 확인 창 */
type Confirming =
  | { kind: 'use'; personaSeq: number }
  | { kind: 'reuse'; version: number }
  | { kind: 'delete'; personaSeq: number }
  | null

const POLL_MS = 2000 // 적용 대기 중일 때만 다시 받는 간격 (AI 확인으로 서버 상태가 바뀌므로)
// '친절 안내형을' · '빠른 접수형을' — 이름 끝 글자의 받침으로 을/를
const hasBatchim = (name: string) => {
  const c = name.charCodeAt(name.length - 1) - 0xac00
  return c >= 0 && c < 11172 && c % 28 !== 0
}
const nameEul = (name: string) => `${name}${hasBatchim(name) ? '을' : '를'}`
const nameI = (name: string) => `${name}${hasBatchim(name) ? '이' : '가'}`
const conflictText =
  '그새 다른 관리자가 이 상담가를 저장했습니다. 창을 닫고 최신 버전을 확인해 주세요.'

/** 07 AI 상담가 훅 (11/11 — 저장 = 새 버전, [적용] 없음)
 * 가운데 = 고른 상담가의 현재 버전(확정된 최신). 오른쪽 위 탭 [버전 히스토리] → 오른쪽이 고른 상담가의 버전 기록, 고른 버전이 가운데
 * 지난 버전: 현재 버전 기준 차이 표시 · [이 버전 다시 쓰기](그 내용을 새 버전으로 저장)
 * 통화 상담가 바꾸기 · 새 버전 반영은 [통화에 사용하기]로만. 시험 통화는 따로 (안 해도 사용 가능, 11/11 사용자) */
export function usePersonaPage() {
  const [personaSeq, setPersonaSeq] = useState<number | null>(null) // null = 통화에 사용 중인 상담가
  const [historyOpen, setHistoryOpen] = useState(false) // 오른쪽 = 버전 기록
  const [version, setVersion] = useState<number | null>(null) // 기록에서 고른 버전 (null = 현재 버전)
  const [editing, setEditing] = useState(false) // 수정 화면
  const [testing, setTesting] = useState<number | null>(null) // 시험 통화 중인 버전
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [adding, setAdding] = useState(false)
  const qc = useQueryClient()
  const options = useVoiceOptions() // 다시 쓰기에서 속도를 AI 지원 범위로 맞춰 보낼 때
  // 추가 · 수정 · 사용하기는 SUPERVISOR · SYSTEM_ADMIN만 (백엔드 persona-head-management.md) → OPERATOR는 보기 · 시험 통화만 (11/02 사용자)
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
  const all = versions.data ?? [] // 높은 번호가 위 (personaMap이 정렬). 남은 초안이 있으면 맨 위
  const latest = all[0] ?? null // 수정의 시작점 — 남은 초안이 있으면 초안
  const head = all.find((v) => v.isHead) ?? latest // 현재 버전
  const viewing = (historyOpen && all.find((v) => v.version === version)) || head
  const past = !!viewing && viewing !== head
  const inUse = list.find((p) => p.inUse) ?? null
  const voiceName = (v: string) => v || DEFAULT_VOICE_LABEL
  const badges = (v: PersonaVersion) => {
    const b: Badge[] = []
    if (v.status === 'ACTIVE') b.push(VERSION_BADGE.ACTIVE)
    if (v.status === 'PENDING') b.push(VERSION_BADGE.PENDING)
    return b
  }

  // 다시 쓰기 = 고른 버전 내용으로 저장. 수정의 시작점(latest)과 다른 칸만 보냄 — 수정 [저장]과 같은 규칙
  const reuseDiff = (v: PersonaVersion) => {
    if (!latest) return null
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
  const viewingDiff = past && viewing ? reuseDiff(viewing) : null
  // 남은 초안이 없고 내용도 같으면 보낼 게 없음 (서버는 빈 저장을 400으로 거절)
  const reuseSame = !!viewingDiff?.same && !persona?.draftRevision

  const confirm = useMutation({
    mutationFn: async (c: NonNullable<Confirming>) => {
      if (c.kind === 'use') {
        const p = list.find((x) => x.personaSeq === c.personaSeq)
        if (p) await requestApply(p.personaSeq, p.head)
        return
      }
      if (c.kind === 'delete') return deletePersona(c.personaSeq)
      const v = all.find((x) => x.version === c.version)
      const d = v && reuseDiff(v)
      if (!persona || !d) return
      await saveVersion(persona.personaSeq, {
        expectedVersion: persona.head.version,
        expectedDraftRevision: persona.draftRevision,
        name: d.name,
        prompt: d.prompt,
        voice: d.voice,
        rateRange: options.rateRange,
      })
    },
    onSuccess: async (_, c) => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      setConfirming(null)
      if (c.kind === 'reuse') {
        setVersion(null) // 새로 생긴 현재 버전을 보여 줌
      }
      if (c.kind === 'delete' && c.personaSeq === persona?.personaSeq) {
        // 지운 상담가를 보고 있었으면 통화에 사용 중인 상담가로 돌아감 (persona 계산이 못 찾으면 inUse로 넘김)
        setPersonaSeq(null)
        setVersion(null)
        setHistoryOpen(false)
      }
    },
    onError: (e, c) => {
      if (e instanceof ConfirmError) void qc.invalidateQueries({ queryKey: personaQueries.all() })
      // 삭제는 그새 바뀐 경우(404 이미 지움 · 409 그새 적용됨) 최신 목록을 다시 받음. 이미 없으면 창도 닫음
      if (c.kind === 'delete' && e instanceof ApiError && (e.status === 404 || e.status === 409)) {
        void qc.invalidateQueries({ queryKey: personaQueries.all() })
        if (e.status === 404) setConfirming(null)
      }
    },
  })

  // 칸마다 따로 비교 — 한 칸의 줄이 다른 칸 줄과 짝지어지지 않게. 바로 직전 버전 → 고른 버전 (11/11 문서 비교처럼 한 화면에)
  // all은 높은 번호가 위 → 처음 만나는 더 낮은 번호가 바로 직전 버전. 남은 초안은 기록이 아님
  const promptSections = (v: PersonaVersion) => {
    const before = historyOpen ? all.find((x) => !x.isDraft && x.version < v.version) : undefined
    const sections = PROMPT_SECTIONS.map((s) => {
      let rows: { key: string; parts: Part[] }[] | null = null
      if (before) {
        const d = inlineDiff(before.prompt[s.key].split('\n'), v.prompt[s.key].split('\n'))
        rows = d.blocks.map((parts, i) => ({ key: String(i), parts }))
      }
      return { ...s, text: v.prompt[s.key], rows }
    })
    return { sections }
  }

  // [수정]은 늘 맨 위에서 시작 — 남은 초안이 있으면 그 내용, 없으면 현재 버전 (11/02 결정)
  const editTarget: EditTarget | null =
    persona && latest
      ? {
          personaSeq: persona.personaSeq,
          personaName: latest.name,
          prompt: latest.prompt,
          voice: latest.voice,
          basedOn: persona.head.version,
          draftRevision: persona.draftRevision,
          saveTo: persona.head.version + 1,
        }
      : null

  const diff = viewing ? promptSections(viewing) : null

  const testingVersion = all.find((v) => v.version === testing) ?? null
  const testCall: TestCallTarget | null =
    persona && testingVersion
      ? {
          personaSeq: persona.personaSeq,
          version: testingVersion.version,
          subtitle: [
            persona.name,
            fmtVersionTime(testingVersion.savedAt),
            voiceName(testingVersion.voice.voice),
          ].join(' · '),
        }
      : null

  const confirmView = ((): {
    title: string
    note: string
    okLabel: string
    danger?: boolean // 확인 버튼을 빨간색으로
  } | null => {
    if (confirming?.kind === 'delete') {
      const p = list.find((x) => x.personaSeq === confirming.personaSeq)
      if (!p) return null
      return {
        title: `${nameEul(p.name)} 삭제할까요?`,
        note: '삭제하면 상담가 목록에서 사라집니다.',
        okLabel: '삭제',
        danger: true,
      }
    }
    if (confirming?.kind === 'use') {
      const p = list.find((x) => x.personaSeq === confirming.personaSeq)
      if (!p) return null
      const until = p.inUse
        ? ' 그 전까지는 이전 버전이 계속 쓰입니다.'
        : inUse
          ? ` 그 전까지는 ${nameI(inUse.name)} 계속 쓰입니다.`
          : ''
      return {
        title: p.inUse ? '새 버전을 통화에 쓸까요?' : `${nameEul(p.name)} 통화에 쓸까요?`,
        note: `진행 중인 통화가 끝나면(AI 확인 후) ${p.name}의 현재 버전으로 응대합니다.${until}`,
        okLabel: '사용하기',
      }
    }
    if (confirming?.kind === 'reuse') {
      const v = all.find((x) => x.version === confirming.version)
      if (!v) return null
      return {
        title: `${fmtVersionTime(v.savedAt)} 버전을 다시 쓸까요?`,
        note: '이 버전 내용으로 새 버전을 저장합니다. 지금 버전도 기록에 남습니다. 통화에는 [통화에 사용하기]로 반영됩니다.',
        okLabel: '다시 쓰기',
      }
    }
    return null
  })()

  const startEdit = () => {
    setVersion(null)
    setEditing(true)
  }

  return {
    demo: PERSONA_DEMO, // 시연 모드 — 저장 · 사용하기가 실서버에 안 감
    isLoading: personas.isPending, // 처음 들어올 때만 화면 전체
    // 상담가를 바꿀 때 버전을 받는 동안은 가운데만 — 오른쪽 카드가 다시 그려지면 스크롤이 맨 위로 감 (11/10)
    promptLoading: persona !== null && versions.isPending,
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt:
      persona && viewing
        ? ({
            time: fmtVersionTime(viewing.savedAt),
            author: viewing.author,
            badges: badges(viewing),
            sections: diff!.sections,
            canEdit: canManage && !past,
            past,
            reuse:
              canManage && past
                ? {
                    disabled: reuseSame,
                    hint: reuseSame ? '현재 버전과 내용이 같습니다' : undefined,
                  }
                : null,
          } satisfies PromptView)
        : null,

    // 버전 기록 (오른쪽 위 탭)
    historyOpen,
    historyTitle: persona?.name ?? '',
    history: all
      .filter((v) => !v.isDraft) // 남은 초안은 기록이 아님 — [프롬프트 수정]에서 이어 쓰고 [저장]하면 버전이 됨
      .map((v): HistoryRow => ({
        version: v.version,
        time: fmtVersionTime(v.savedAt),
        voice: voiceName(v.voice.voice),
        author: v.author,
        badges: badges(v),
        selected: v === viewing,
      })),
    openHistory: () => {
      setVersion(null)
      setHistoryOpen(true)
    },
    closeHistory: () => {
      setHistoryOpen(false)
      setVersion(null)
    },
    selectVersion: (v: number) => {
      setVersion(v)
    },

    // 확인 창 — [통화에 사용하기] · [이 버전 다시 쓰기]
    confirm: confirmView,
    askUse: (seq: number) => {
      confirm.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
      setConfirming({ kind: 'use', personaSeq: seq })
    },
    askReuse: () => {
      confirm.reset()
      if (viewing) setConfirming({ kind: 'reuse', version: viewing.version })
    },
    askDelete: (seq: number) => {
      confirm.reset()
      setConfirming({ kind: 'delete', personaSeq: seq })
    },
    confirmOk: () => confirming && confirm.mutate(confirming),
    confirmCancel: () => setConfirming(null),
    confirmBusy: confirm.isPending,
    confirmError: !confirm.error
      ? null
      : confirm.error instanceof ConfirmError
        ? '내용은 저장됐지만 새 버전으로 올리지 못했습니다. 다시 시도해 주세요.'
        : (unsupportedText(confirm.error) ??
          (confirm.error instanceof ApiError && confirm.error.status === 409
            ? confirming?.kind === 'delete'
              ? '통화에 사용 중이거나 적용 대기 중인 상담가는 삭제할 수 없습니다.'
              : conflictText
            : '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.')),

    adding,
    canAdd: canManage,
    openAdd: () => setAdding(true),
    closeAdd: () => setAdding(false),
    // 추가하면 그 상담가를 골라 보여 줌
    added: (seq: number) => {
      setAdding(false)
      setPersonaSeq(seq)
      setVersion(null)
      setHistoryOpen(false)
    },

    testCall,
    // [시험 통화] — 가운데에서 보고 있는 버전으로 (지난 버전도 가능). 통화에 사용하기와는 별개 (11/11)
    startTestCall: () => viewing && setTesting(viewing.version),
    endTestCall: () => setTesting(null),

    editing,
    editTarget,
    startEdit,
    // 저장하면 새로 생긴 현재 버전을 보여 줌 (취소면 그대로)
    finishEdit: () => {
      setEditing(false)
      setVersion(null)
    },

    personas: list.map((p): PersonaItem => {
      const newer = p.inUse && !p.applyingVersion && p.head.version !== p.appliedVersion
      return {
        personaSeq: p.personaSeq,
        name: p.name,
        selected: p.personaSeq === persona?.personaSeq,
        inUse: p.inUse,
        applying: p.applyingVersion
          ? `${VERSION_BADGE.PENDING.label}${p.applyError ? ' · AI 반영 오류' : ''}`
          : null,
        voice: voiceName(p.voice.voice),
        deletable: canManage && !p.inUse && !p.applyingVersion,
        note: newer ? '통화엔 이전 버전 사용 중' : null,
        useLabel:
          !canManage || p.applyingVersion
            ? null
            : !p.inUse
              ? '통화에 사용하기'
              : newer
                ? '새 버전 통화에 사용하기'
                : null,
      }
    }),
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
    },
  }
}
