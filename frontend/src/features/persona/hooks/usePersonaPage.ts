import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router'
import { fmtVersionTime } from '@/shared/lib/format'
import { ApiError } from '@/shared/api/client'
import { useSession } from '@/shared/auth/useSession'
import { useShell } from '@/shared/lib/shell'
import type { Tone } from '@/shared/ui'
import {
  DEFAULT_VOICE_LABEL,
  PROMPT_SECTIONS,
  unsupportedText,
  VERSION_BADGE,
} from '@/features/persona/labels'
import type { EditTarget } from '@/features/persona/hooks/usePromptEditor'
import { inlineDiff, type Part } from '@/features/persona/hooks/lineDiff'
import { useVoiceOptions } from '@/features/persona/hooks/useVoiceOptions'
import { useTestGate } from '@/features/persona/hooks/useScenarioTest'
import { useApplyTest } from '@/features/persona/hooks/useApplyTest'
import {
  SCENARIO_TEST,
  scenarioTestQueries,
  stopTest,
} from '@/features/persona/api/scenarioTestApi'
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
  author: string
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

/** [통화에 사용하기] · [삭제] 확인 창, 수정 기록 창 [이 내용 불러오기](reuse — 확인 창 없이 바로) */
type Confirming =
  | { kind: 'use'; personaSeq: number }
  | { kind: 'reuse'; version: number }
  | { kind: 'delete'; personaSeq: number }
  | { kind: 'test' } // 띠의 [통화에 반영] — 시험하고 반영 (모두 통과면 저절로 반영)
  | { kind: 'stop' } // 띠의 [시험 중단] (2번)
  | { kind: 'review' } // 확인 필요 띠의 [확인하고 반영] (4번) — 실패를 보고도 반영
  | null

// 시나리오 시험에 다녀오거나 새로고침해도 보던 상담가 · 버전 그대로 — 기록(location.key)마다 세션 저장소에 기억
// (메모리에만 두면 새로고침 때 처음 화면으로 돌아감, 11/12 사용자). 사이드바로 새로 들어오면 새 기록이라 처음 화면
type Kept = { personaSeq: number | null; historyOpen: boolean; version: number | null }
const KEEP = 'personas:view:'
const kept = (key: string): Kept | null => {
  try {
    return JSON.parse(sessionStorage.getItem(KEEP + key) ?? 'null') as Kept | null
  } catch {
    return null // 저장소를 못 쓰는 환경 · 깨진 값이면 처음 화면
  }
}
const keep = (key: string, v: Kept) => {
  try {
    sessionStorage.setItem(KEEP + key, JSON.stringify(v))
  } catch {
    // 못 쓰면 기억하지 않을 뿐
  }
}
/** 시나리오 시험의 ‹ 가 넘겨 준 상담가 · 버전 (새로고침 뒤라 뒤로가기가 아닌 링크로 왔을 때) → 시험하던 버전을 가운데에
 *  version = 지난 버전일 때만 (현재 버전이면 없음 → 상담가 유형 화면 그대로) */
const fromTest = (state: unknown): Kept | null => {
  const s = state as { testOf?: number; version?: number } | null
  if (typeof s?.testOf !== 'number') return null
  const version = typeof s.version === 'number' ? s.version : null
  return { personaSeq: s.testOf, historyOpen: version !== null, version }
}

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

/** 07 AI 상담가 훅 (11/13 새 안 — 저장 = 새 버전)
 * 카드 = 위 탭에서 고른 상담가의 현재 버전(그 자리에서 고침). 사용 중 상담가의 새 버전이 통화에 안 쓰이면 반영 전 띠
 * 수정 기록 창: 고른 날짜 내용을 통화에 쓰는 내용과 비교 · [이 내용 불러오기](그 내용을 새 버전으로 저장)
 * 통화 상담가 바꾸기 · 새 버전 반영은 확인 창으로만. 시나리오 시험은 따로 화면 */
export function usePersonaPage() {
  const { key, state } = useLocation()
  const [back] = useState(() => (SCENARIO_TEST ? (kept(key) ?? fromTest(state)) : null))
  const [personaSeq, setPersonaSeq] = useState<number | null>(back?.personaSeq ?? null) // null = 통화에 사용 중인 상담가
  const [historyOpen, setHistoryOpen] = useState(back?.historyOpen ?? false) // 수정 기록 창 (11/13 새 안 5번)
  const [version, setVersion] = useState<number | null>(back?.version ?? null) // 창에서 고른 버전 (null = 현재 버전)
  const [showCall, setShowCall] = useState(false) // 반영 전 띠의 토글 — true = 통화에 쓰는 내용
  useEffect(() => {
    if (SCENARIO_TEST) keep(key, { personaSeq, historyOpen, version })
  }, [key, personaSeq, historyOpen, version])
  const gate = useTestGate() // 전체 시나리오 시험이 끝나야 [통화에 사용하기] (시나리오 시험이 꺼진 환경이면 null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [adding, setAdding] = useState(false)
  const qc = useQueryClient()
  const options = useVoiceOptions() // 다시 쓰기에서 속도를 AI 지원 범위로 맞춰 보낼 때
  // 추가 · 수정 · 사용하기 · 삭제는 모든 관리자(OPERATOR · SYSTEM_ADMIN) — 11/11 백엔드 권한 이분화 (11/02 'OPERATOR는 보기만'을 뒤집음)
  // 내 정보를 불러오기 전(role undefined)에는 숨김
  const { role } = useSession()
  const canManage = role !== undefined
  const { liveCalls } = useShell() // 바꾸기 확인 창 '지금 통화 중인 n건은 바뀌지 않습니다' (6번)

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
  const viewing = head // 카드는 늘 현재 버전 — 지난 버전은 수정 기록 창 안에서만 (11/13 새 안)
  const picked = historyOpen ? (all.find((v) => v.version === version) ?? head) : null
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
  // 남은 초안이 없고 내용도 같으면 보낼 게 없음 (서버는 빈 저장을 400으로 거절)
  const reuseSame = (v: PersonaVersion) => !!reuseDiff(v)?.same && !persona?.draftRevision

  // 현재 버전이 아직 통화에 안 쓰임 (적용 대기 중이면 기다림)
  const newerThanCall = (p: (typeof list)[number]) =>
    p.inUse && !p.applyingVersion && p.head.version !== p.appliedVersion

  // 반영 전 띠 (11/13 새 안 1번) — 사용 중 상담가의 현재 버전이 아직 통화에 안 쓰일 때. 지난 버전을 볼 땐 없음
  const unapplied = !!persona && newerThanCall(persona)
  // 토글 '통화에 쓰는 내용' — 그 버전을 못 찾으면(목록 밖) 토글 없음
  const callVersion = unapplied
    ? (all.find((v) => v.version === persona.appliedVersion) ?? null)
    : null
  // 6번 — 통화에 안 쓰는 상담가를 통화에 쓰기: 현재 버전을 먼저 시험. 모두 통과해도 저절로 바꾸지 않음(담당자가 [통화에 사용하기])
  const switching = !!persona && !persona.inUse
  // 띠의 시험 → 반영 (11/13 새 안 1번) — 반영 전인 고친 내용(현재 버전) · 6번은 안 쓰는 상담가의 현재 버전
  const applyTarget =
    (unapplied || (switching && !persona.applyingVersion)) && head && !head.isDraft
      ? {
          personaSeq: persona.personaSeq,
          head: persona.head,
          promptText: head.promptText,
          voiceId: head.voice.voice || null,
        }
      : null
  const applyTest = useApplyTest(applyTarget, { auto: !switching })
  // 반영 중 = AI가 확인하는 중 — 사용 중 상담가의 새 버전(1번) · 다른 상담가로 바꾸는 중(6번)
  const applyingVersion = persona?.applyingVersion
    ? (all.find((v) => v.version === persona.applyingVersion) ?? head)
    : null
  // stopped = 시험을 멈춤(2번) — [통화에 반영] 대신 [다시 시험하고 반영], 입력 칸은 다시 열림
  // review = 시험이 끝났는데 실패가 있음(4번) — 바로 반영하지 않고 담당자가 [확인하고 반영]
  // 연결 실패가 섞인 일부 시험(partial)도 실패가 있으면 확인 필요 (피그마 3 · 4번: 통과 7 · 실패 2 · 연결 실패 1)
  // passed = 6번 시험 통과 — 띠의 [통화에 사용하기]. 6번의 실패 · 중단은 4번 확인 필요 · 2번 시험 중단 띠를 그대로 (11/13 사용자)
  const step: 'unapplied' | 'testing' | 'stopped' | 'review' | 'applying' | 'passed' | null =
    applyingVersion
      ? 'applying'
      : switching
        ? applyTest.state === 'running'
          ? 'testing'
          : applyTest.allPass
            ? 'passed'
            : applyTest.stopped
              ? 'stopped'
              : (applyTest.state === 'done' || applyTest.state === 'partial') && applyTest.fail > 0
                ? 'review'
                : null
        : !unapplied
          ? null
          : applyTest.state === 'running'
            ? 'testing'
            : applyTest.stopped
              ? 'stopped'
              : (applyTest.state === 'done' || applyTest.state === 'partial') && applyTest.fail > 0
                ? 'review'
                : 'unapplied'
  // 시험 · 반영 중엔 입력 칸 · 목소리 · 이름 · 수정 기록 보기를 막음 — 고치면 새 버전이 생겨 시험하던 글과 달라짐
  const locked = step === 'testing' || step === 'applying'
  const comparing = showCall && callVersion !== null && !locked
  const confirm = useMutation({
    mutationFn: async (c: NonNullable<Confirming>) => {
      if (c.kind === 'use') {
        const p = list.find((x) => x.personaSeq === c.personaSeq)
        if (p) await requestApply(p.personaSeq, p.head)
        return
      }
      if (c.kind === 'delete') return deletePersona(c.personaSeq)
      if (c.kind === 'test') {
        if (applyTarget) await applyTest.start(applyTarget)
        return
      }
      if (c.kind === 'review') {
        if (applyTarget) await applyTest.apply(applyTarget) // 반영되면 띠가 반영 중으로
        return
      }
      if (c.kind === 'stop') {
        if (!applyTarget) return
        // 실패해도 목록을 다시 받음(일부 묶음만 멈췄을 수 있음). 멈추면 띠가 시험 중단으로 바뀜 (저절로 반영 약속은 useApplyTest가 지움)
        try {
          await stopTest({ personaSeq: applyTarget.personaSeq, version: applyTarget.head.version })
        } finally {
          await qc.invalidateQueries({ queryKey: scenarioTestQueries.tests().queryKey })
        }
        return
      }
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
        // 창을 닫고 새로 생긴 현재 버전(고친 내용)을 보여 줌 → 사용 중 상담가면 반영 전 띠
        setHistoryOpen(false)
        setVersion(null)
        setShowCall(false)
      }
      if (c.kind === 'delete' && c.personaSeq === persona?.personaSeq) {
        // 지운 상담가를 보고 있었으면 통화에 사용 중인 상담가로 돌아감 (persona 계산이 못 찾으면 inUse로 넘김)
        setPersonaSeq(null)
        setVersion(null)
        setHistoryOpen(false)
      }
    },
    onError: (e, c) => {
      // 시험 시작은 응답을 못 받아도 걸렸을 수 있음 → 창을 닫고 띠에서 알림 (다시 누르면 요금이 두 번)
      if (c.kind === 'test') return setConfirming(null)
      if (e instanceof ConfirmError) void qc.invalidateQueries({ queryKey: personaQueries.all() })
      // 삭제는 그새 바뀐 경우(404 이미 지움 · 409 그새 적용됨) 최신 목록을 다시 받음. 이미 없으면 창도 닫음
      if (c.kind === 'delete' && e instanceof ApiError && (e.status === 404 || e.status === 409)) {
        void qc.invalidateQueries({ queryKey: personaQueries.all() })
        if (e.status === 404) setConfirming(null)
      }
    },
  })

  // 칸마다 따로 비교 — 한 칸의 줄이 다른 칸 줄과 짝지어지지 않게. before → v (before가 없으면 비교 없음)
  const promptSections = (v: PersonaVersion, before?: PersonaVersion) => {
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

  // [수정]은 늘 맨 위에서 시작 — 남은 초안이 있으면 그 내용, 없으면 현재 버전 (11/02 결정)
  // 저장 직후 목록(현재 버전 번호)이 버전 기록보다 먼저 오면 옛 글로 입력 칸이 새로 떠 '고치는 중'처럼 보였음
  // → 버전 기록이 따라올 때까지 입력 칸을 띄우지 않음 (남은 초안이 있으면 맨 위가 초안이라 비교 안 함)
  const fresh =
    !!persona && !!latest && (!!persona.draftRevision || latest.version === persona.head.version)
  const editTarget: EditTarget | null =
    persona && latest && fresh
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

  const confirmView = ((): {
    title: string
    note: string
    okLabel: string
    changes?: { fail: number; pass: number } | null // 통화에 사용 중인 버전과 달라진 시나리오 수 (사용하기 확인 창)
    danger?: boolean // 확인 버튼을 빨간색으로
    testTo?: string // [시나리오 시험] — 통화에 쓸 버전의 시험 화면 (시나리오 시험이 꺼진 환경이면 없음)
    blocked?: boolean // 전체 시험 전 → 확인 버튼 끔, [시나리오 시험]으로 유도
    failed?: string[] // 실패한 시나리오 이름 — 확인하고 반영 창 (4번, 피그마 2368:5978)
  } | null => {
    if (confirming?.kind === 'review') {
      if (step !== 'review') return null // 그새 반영 · 다시 고침이면 창을 닫음
      // 6번 — 마지막 확인은 사용 확인 창 모양 그대로 + 실패 이름
      if (switching)
        return {
          title: `실패한 시나리오 ${applyTest.failed.length}개가 있습니다. ${nameEul(persona.name)} 통화에 사용할까요?`,
          note: `다음 통화부터 ${inUse ? `${inUse.name} 대신 ` : ''}${nameI(persona.name)} 응대합니다.${liveCalls ? ` 지금 통화 중인 ${liveCalls}건은 바뀌지 않습니다.` : ''}`,
          okLabel: '사용하기',
          failed: applyTest.failed,
        }
      return {
        title: `실패한 시나리오 ${applyTest.failed.length}개가 있습니다. 통화에 반영할까요?`,
        note: '반영하면 다음 통화부터 고친 내용으로 응대합니다.',
        okLabel: '반영',
        failed: applyTest.failed,
      }
    }
    if (confirming?.kind === 'delete') {
      const p = list.find((x) => x.personaSeq === confirming.personaSeq)
      if (!p) return null
      return {
        title: `${nameEul(p.name)} 삭제할까요?`,
        note: '삭제하면 되돌릴 수 없습니다.',
        okLabel: '삭제',
        danger: true,
      }
    }
    if (confirming?.kind === 'stop') {
      if (step !== 'testing') return null // 그새 시험이 끝났으면 창을 닫음
      return {
        title: '시험을 중단할까요?',
        note: '지금까지 돌린 결과는 남습니다. 통화에는 반영되지 않고, 다시 시험해야 반영할 수 있습니다.',
        okLabel: '중단',
        danger: true,
      }
    }
    if (confirming?.kind === 'test') {
      const n = applyTest.toRun
      if (switching)
        return {
          title: `통화에 쓰기 전에 ${nameEul(persona.name)} 시험할까요?`,
          note: `${applyTest.resume ? `남은 시나리오 ${n}개를` : `시나리오 ${n}개를 모두`} 돌린 뒤, 결과를 보고 통화에 사용할지 정합니다.`,
          okLabel: '시험 시작',
        }
      return {
        title: '시험하고 통화에 반영할까요?',
        note: `${applyTest.resume ? `남은 시나리오 ${n}개를` : `시나리오 ${n}개를 모두`} 돌립니다. 모두 통과하면 바로 반영하고, 실패가 있으면 결과를 확인한 뒤 반영할 수 있습니다.`,
        okLabel: '시험하고 반영',
      }
    }
    if (confirming?.kind === 'use') {
      const p = list.find((x) => x.personaSeq === confirming.personaSeq)
      if (!p) return null
      // 6번 시험 통과 → 바꾸기 확인 (피그마 6번 줄 '통화에 사용 확인')
      if (switching && step === 'passed' && p.personaSeq === persona.personaSeq)
        return {
          title: `${nameEul(p.name)} 통화에 사용할까요?`,
          note: `다음 통화부터 ${inUse ? `${inUse.name} 대신 ` : ''}${nameI(p.name)} 응대합니다.${liveCalls ? ` 지금 통화 중인 ${liveCalls}건은 바뀌지 않습니다.` : ''}`,
          okLabel: '사용하기',
        }
      const until = p.inUse
        ? ' 그 전까지는 이전 버전이 계속 쓰입니다.'
        : inUse
          ? ` 그 전까지는 ${nameI(inUse.name)} 계속 쓰입니다.`
          : ''
      // 저장만으로는 통화에 안 감 → 저장 직후에도 이 창 (11/13 사용자: 저장 = 바로 반영으로 오해)
      const g = gate?.(p.personaSeq, p.head.version)
      // 11/13 페르소나 전면 수정 동안 시험 없이도 적용 (시험할 때마다 비용). 다시 막으려면 !!g && g.state !== 'done'
      const blocked = false
      return {
        title: p.inUse ? '새 버전을 통화에 반영할까요?' : `${nameEul(p.name)} 통화에 쓸까요?`,
        note: blocked
          ? '이 버전은 아직 전체 시나리오 시험을 하지 않았습니다. 시험을 마치면 통화에 반영할 수 있습니다.'
          : `진행 중인 통화가 끝나면(AI 확인 후) ${p.name}의 현재 버전으로 응대합니다.${until}`,
        okLabel: p.inUse ? '반영' : '사용하기',
        changes: g?.state === 'done' ? { fail: g.newFail, pass: g.newPass } : null, // 시험한 버전만 변화 수
        testTo: g ? `/personas/${p.personaSeq}/tests/${p.head.version}` : undefined,
        blocked,
      }
    }
    return null
  })()

  // 6번 — 시험 전 · 실패 · 중단이면 시험부터 (모두 통과면 바로 바꾸기 확인). 시나리오 시험이 꺼진 환경이면 예전처럼 바로
  const askUse = (seq: number) => {
    confirm.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
    if (switching && seq === persona.personaSeq && applyTest.on && step !== 'passed') {
      applyTest.resetStart()
      return setConfirming({ kind: 'test' })
    }
    setConfirming({ kind: 'use', personaSeq: seq })
  }
  // 수정 기록 창의 비교 기준 = 통화에 쓰는 내용 (안 쓰는 상담가는 appliedVersion = 현재 버전)
  const base = persona ? (all.find((v) => v.version === persona.appliedVersion) ?? head) : null

  const items = [...list]
    .sort((a, b) => Number(b.inUse) - Number(a.inUse))
    .map((p): PersonaItem => {
      // 6번 시험 중 · 시험 통과 — [삭제]는 시험 중만, [통화에 사용하기]는 띠로 옮김 (피그마 6번 줄)
      const mine = p.personaSeq === persona?.personaSeq
      return {
        personaSeq: p.personaSeq,
        name: p.name,
        selected: mine,
        inUse: p.inUse,
        applying: p.applyingVersion
          ? `${VERSION_BADGE.PENDING.label}${p.applyError ? ' · AI 반영 오류' : ''}`
          : null,
        voice: voiceName(p.voice.voice),
        deletable: canManage && !p.inUse && !p.applyingVersion && !(mine && step === 'testing'),
        // 시험 전이어도 켬 — 누르면 확인 창이 [시나리오 시험]으로 유도 (11/13, 11/12의 '말없이 끔'을 바꿈)
        canUse: canManage && !p.inUse && !p.applyingVersion && !(mine && step !== null),
      }
    })

  return {
    demo: PERSONA_DEMO, // 시연 모드 — 저장 · 사용하기가 실서버에 안 감
    isLoading: personas.isPending, // 처음 들어올 때만 화면 전체
    // 상담가를 바꿀 때 버전을 받는 동안은 가운데만 — 오른쪽 카드가 다시 그려지면 스크롤이 맨 위로 감 (11/10)
    promptLoading: persona !== null && versions.isPending,
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt:
      persona && viewing
        ? ({
            // 띠가 있으면 머리 줄 = 통화에 쓰는 버전의 저장 시각, 띠 = 고친 버전 (피그마처럼)
            time: fmtVersionTime((callVersion ?? viewing).savedAt),
            author: (callVersion ?? viewing).author,
            sections: diff!.sections,
            // 토글이 '통화에 쓰는 내용'이면 그 버전 글 (읽기만)
            callSections: comparing ? promptSections(callVersion).sections : null,
            canEdit: canManage && !locked,
          } satisfies PromptView)
        : null,

    // 수정 기록 창 (11/13 새 안 5번, 피그마 2368:6500) — 왼쪽 날짜별 목록, 오른쪽은 통화에 쓰는 내용과 다른 칸만
    historyOpen,
    history: all
      .filter((v) => !v.isDraft) // 남은 초안은 기록이 아님 — 고쳐서 [저장]하면 버전이 됨
      .map((v): HistoryRow => ({
        version: v.version,
        time: fmtVersionTime(v.savedAt),
        author: v.author,
        badges: [...(unapplied && v === head ? [VERSION_BADGE.UNAPPLIED] : []), ...badges(v)],
        selected: v === picked,
      })),
    picked:
      picked && base
        ? {
            title: `${fmtVersionTime(picked.savedAt)} 내용`,
            changed: promptSections(picked, base).sections.filter((x) => x.rows),
            // [이 내용 불러오기] — 지금 내용과 같으면 보낼 게 없음
            canLoad: canManage && !reuseSame(picked),
            same: reuseSame(picked),
          }
        : null,
    loadPicked: () => picked && confirm.mutate({ kind: 'reuse', version: picked.version }),
    loading: confirm.isPending,
    // 띠 — 반영 전 · 시험 중 · 반영 중 (11/13 새 안 1번). 고친 내용 = 반영 중이면 그 버전, 아니면 현재 버전
    band:
      step && (applyingVersion ?? head)
        ? {
            step,
            // 6번 — 다른 상담가로 바꾸는 띠 문구: '통화에 쓰기 전 시험' · '다음 통화부터 친절형이 응대합니다'
            switchNote: switching ? `다음 통화부터 ${nameI(persona.name)} 응대합니다` : null,
            time: fmtVersionTime((applyingVersion ?? head)!.savedAt),
            author: (applyingVersion ?? head)!.author,
            canApply: canManage,
            canCompare: callVersion !== null && !locked,
            // 시험 중 — 시나리오 4 / 10 · 통과 3 · 실패 1 (연결 실패는 끝난 수에만)
            progress:
              step === 'testing'
                ? {
                    ended: applyTest.ended,
                    total: applyTest.total,
                    pass: applyTest.pass,
                    fail: applyTest.fail,
                  }
                : null,
            // 시험 중단 — 시나리오 4 / 10에서 멈춤 · 시작 시각
            stopped:
              step === 'stopped' && applyTest.stopped
                ? {
                    ended: applyTest.ended,
                    total: applyTest.total,
                    at: fmtVersionTime(applyTest.stopped.at),
                  }
                : null,
            // 확인 필요 — 시나리오 2개 실패 · 시험 시각 (4번)
            review:
              step === 'review'
                ? {
                    fail: applyTest.failed.length,
                    at: applyTest.at ? fmtVersionTime(applyTest.at) : '',
                  }
                : null,
            // 6번 시험 통과 — 시나리오 10개 모두 통과 · 시험 시각
            passed:
              step === 'passed'
                ? { total: applyTest.total, at: applyTest.at ? fmtVersionTime(applyTest.at) : '' }
                : null,
            applyError: step === 'applying' ? (persona?.applyError ?? null) : null,
            error: applyTest.startError ?? applyTest.applyError,
          }
        : null,
    locked,
    showCall: comparing,
    setShowCall,
    // [통화에 반영] — 시나리오 시험이 꺼진 환경 · 이미 모두 통과 = 바로 반영 확인, 아니면 시험하고 반영 확인
    // [시험 중단] — 확인 창 (2번)
    askStop: () => {
      confirm.reset()
      setConfirming({ kind: 'stop' })
    },
    // [확인하고 반영] — 실패한 시나리오 이름을 보여 주고 반영 (4번)
    askReview: () => {
      confirm.reset()
      setConfirming({ kind: 'review' })
    },
    applyHead: () => {
      if (!persona) return
      if (!applyTest.on || applyTest.allPass) return askUse(persona.personaSeq)
      confirm.reset()
      applyTest.resetStart()
      setConfirming({ kind: 'test' })
    },
    openHistory: () => {
      confirm.reset() // 지난번 불러오기 실패 문구가 먼저 뜨지 않게
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

    // 확인 창 — [통화에 사용하기] · [삭제]
    confirm: confirmView,
    askUse,
    askDelete: (seq: number) => {
      confirm.reset()
      setConfirming({ kind: 'delete', personaSeq: seq })
    },
    confirmOk: () => confirming && confirm.mutate(confirming),
    confirmCancel: () => setConfirming(null),
    confirmBusy: confirm.isPending,
    confirmError: !confirm.error
      ? null
      : confirming?.kind === 'stop'
        ? '시험을 중단하지 못했습니다. 다시 시도해 주세요.'
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

    // [시나리오 시험] — 가운데에서 보고 있는 버전의 시험 화면으로 (지난 버전도). 가짜 모드가 아니면 null (버튼 없음)
    testTo:
      SCENARIO_TEST && persona && viewing
        ? `/personas/${persona.personaSeq}/tests/${viewing.version}`
        : null,

    editTarget,
    // 저장하면 새로 생긴 현재 버전(고친 내용)을 보여 줌. 반영은 띠의 [통화에 반영]으로 (11/13 새 안 — 저장 직후 확인 창 없음)
    finishEdit: () => {
      setVersion(null)
      setShowCall(false)
    },

    // 통화에 사용 중인 상담가는 늘 맨 위 (나머지는 서버가 준 순서 그대로)
    personas: items,
    // 머리 줄 (11/13 새 안 — 이름 · 배지 · 목소리 · [삭제] · [통화에 사용하기]는 탭에서 고른 상담가 것)
    current: items.find((p) => p.selected) ?? null,
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
      setShowCall(false)
    },
  }
}
