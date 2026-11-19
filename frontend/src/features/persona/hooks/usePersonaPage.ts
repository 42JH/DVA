import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { useSession } from '@/shared/auth/useSession'
import { useShell } from '@/shared/lib/shell'
import { unsupportedText } from '@/features/persona/labels'
import { useVoiceOptions } from '@/features/persona/hooks/useVoiceOptions'
import { useApplyTest } from '@/features/persona/hooks/useApplyTest'
import { useKeptView } from '@/features/persona/hooks/useKeptView'
import {
  bandView,
  historyRows,
  personaItems,
  pickedView,
  promptView,
} from '@/features/persona/hooks/personaPageView'
import { callStateOf, editTargetOf, reuseDiff } from '@/features/persona/hooks/personaVersions'
import { bandStep, confirmCopy, type Confirming } from '@/features/persona/hooks/personaBand'
import {
  SCENARIO_TEST,
  scenarioTestQueries,
  stopTest,
} from '@/features/persona/api/scenarioTestApi'
import {
  deletePersona,
  personaQueries,
  requestApply,
  type PersonaVersion,
} from '@/features/persona/api/personaApi'

const POLL_MS = 2000 // 적용 대기 중일 때만 다시 받는 간격 (AI 확인으로 서버 상태가 바뀌므로)
const conflictText =
  '그새 다른 관리자가 이 상담가를 저장했습니다. 창을 닫고 최신 내용을 확인해 주세요.'

/** 확인 창 아래 줄의 오류 문구 */
function confirmErrorText(error: unknown, kind: NonNullable<Confirming>['kind'] | undefined) {
  if (!error) return null
  if (kind === 'stop') return '시험을 중단하지 못했습니다. 다시 시도해 주세요.'
  const unsupported = unsupportedText(error)
  if (unsupported != null) return unsupported
  if (!(error instanceof ApiError && error.status === 409))
    return '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.'
  return kind === 'delete'
    ? '통화에 사용 중이거나 반영 중인 상담가는 삭제할 수 없습니다.'
    : conflictText
}

/** 07 AI 상담가 훅 (새 안 — 저장 = 새 버전)
 * 카드 = 위 탭에서 고른 상담가의 현재 버전(그 자리에서 고침). 사용 중 상담가의 새 버전이 통화에 안 쓰이면 반영 전 띠
 * 수정 기록 창: 고른 날짜 내용을 통화에 쓰는 내용과 비교 · [이 내용 불러오기](카드 칸에 채움 — 저장은 [저장])
 * 통화 상담가 바꾸기 · 새 버전 반영은 확인 창으로만. 시나리오 시험은 따로 화면 */
export function usePersonaPage() {
  const {
    personaSeq,
    setPersonaSeq,
    historyOpen,
    setHistoryOpen,
    version,
    setVersion,
    showCall,
    setShowCall,
  } = useKeptView()
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [adding, setAdding] = useState(false)
  const qc = useQueryClient()
  const options = useVoiceOptions() // 다시 쓰기에서 속도를 AI 지원 범위로 맞춰 보낼 때
  // 추가 · 수정 · 사용하기 · 삭제는 모든 관리자(OPERATOR · SYSTEM_ADMIN) — 11/11 백엔드 권한 이분화 ('OPERATOR는 보기만'을 뒤집음)
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
  const viewing = head // 카드는 늘 현재 버전 — 지난 버전은 수정 기록 창 안에서만
  const picked = historyOpen ? (all.find((v) => v.version === version) ?? head) : null
  const inUse = list.find((p) => p.inUse) ?? null
  // 목소리 값 → 이름 ('' = 기본 음성, AI 목록에 없으면 값 그대로)
  const voiceLabel = (v: string) => options.voiceOptions(v).find((o) => o.value === v)?.label ?? v

  // 불러올 것이 없음 = 고칠 시작점(남은 초안 · 현재 버전)과 내용이 같음
  const reuseSame = (v: PersonaVersion) =>
    !!latest && reuseDiff(v, latest).same && !persona?.draftRevision

  // 통화와의 관계 — 반영 전 띠 · 통화에 쓰는 버전 · 띠에서 시험하고 반영할 대상
  const { unapplied, callVersion, sameTalk, switching, banded, applyTarget } = callStateOf(
    persona,
    all,
    head,
  )
  const applyTest = useApplyTest(applyTarget, { auto: !switching, expected: banded })
  // 카드를 처음 그릴 때는 시험 결과까지 기다림 — 띠가 뜰 상담가를 먼저 그리면 '반영 전' 띠와 열린 입력 칸이 잠깐 보였다가 시험 중 · 확인 필요로 바뀜
  // 한 번 그린 뒤 띠가 생길 때(저장 직후)는 기다리지 않음 — 방금 저장한 내용은 시험한 적이 없어 '반영 전'이 맞고, 카드를 가리면 깜빡임
  const [shownSeq, setShownSeq] = useState<number | null>(null)
  const promptLoading =
    persona !== null &&
    (versions.isPending || (applyTest.loading && shownSeq !== persona.personaSeq))
  if (persona && !promptLoading && shownSeq !== persona.personaSeq) setShownSeq(persona.personaSeq)
  // 반영 중 = AI가 확인하는 중 — 사용 중 상담가의 새 버전(1번) · 다른 상담가로 바꾸는 중(6번)
  const applyingVersion = persona?.applyingVersion
    ? (all.find((v) => v.version === persona.applyingVersion) ?? head)
    : null
  const step = bandStep({ applying: !!applyingVersion, switching, unapplied }, applyTest)
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
    },
    onSuccess: async (_, c) => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      setConfirming(null)
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
      // 삭제는 그새 바뀐 경우(404 이미 지움 · 409 그새 적용됨) 최신 목록을 다시 받음. 이미 없으면 창도 닫음
      if (c.kind === 'delete' && e instanceof ApiError && (e.status === 404 || e.status === 409)) {
        void qc.invalidateQueries({ queryKey: personaQueries.all() })
        if (e.status === 404) setConfirming(null)
      }
    },
  })

  const editTarget = editTargetOf(persona, latest)
  const items = personaItems(list, { currentSeq: persona?.personaSeq, step, canManage })

  const confirmView = confirmCopy(confirming, {
    step,
    current: persona,
    inUseName: inUse?.name ?? null,
    liveCalls,
    sameTalk,
    test: applyTest,
    find: (seq) => list.find((p) => p.personaSeq === seq),
  })

  // 6번 — 시험 전 · 실패 · 중단이면 시험부터 (모두 통과면 바로 바꾸기 확인). 시나리오 시험이 꺼진 환경이면 예전처럼 바로
  const askUse = (seq: number) => {
    confirm.reset() // 지난번 실패 문구가 새 창에 먼저 뜨지 않게
    if (switching && seq === persona?.personaSeq && applyTest.on && step !== 'passed') {
      applyTest.resetStart()
      return setConfirming({ kind: 'test' })
    }
    setConfirming({ kind: 'use', personaSeq: seq })
  }
  // 수정 기록 창의 비교 기준 = 통화에 쓰는 내용 (안 쓰는 상담가는 appliedVersion = 현재 버전)
  const base = persona ? (all.find((v) => v.version === persona.appliedVersion) ?? head) : null

  return {
    isLoading: personas.isPending, // 처음 들어올 때만 화면 전체
    // 상담가를 바꿀 때 버전을 받는 동안은 가운데만 — 오른쪽 카드가 다시 그려지면 스크롤이 맨 위로 감
    promptLoading,
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt:
      persona && viewing
        ? promptView(viewing, {
            callVersion,
            comparing,
            voice: voiceLabel(viewing.voice.voice),
            canEdit: canManage && !locked,
          })
        : null,

    // 수정 기록 창 (새 안 5번, 피그마 2368:6500) — 왼쪽 날짜별 목록, 오른쪽은 통화에 쓰는 내용과 다른 칸만
    historyOpen,
    history: historyRows(all, { head, picked, unapplied }),
    picked:
      picked && base
        ? {
            ...pickedView(picked, base, voiceLabel),
            // [이 내용 불러오기] = 카드 칸에 채우기만 (저장은 [저장]으로). 지금 내용과 같으면 채울 게 없음
            canLoad: canManage && !reuseSame(picked),
            content: { name: picked.name, prompt: picked.prompt, voice: picked.voice },
          }
        : null,
    // 불러온 뒤 — 창을 닫고 고친 내용 쪽을 보여 줌
    loadedPicked: () => {
      setHistoryOpen(false)
      setVersion(null)
      setShowCall(false)
    },
    // 띠 — 반영 전 · 시험 중 · 반영 중 (새 안 1번). 고친 내용 = 반영 중이면 그 버전, 아니면 현재 버전
    band: bandView(step, applyingVersion ?? head, {
      switchTo: switching && persona ? persona.name : null,
      canApply: canManage,
      canCompare: callVersion !== null && !locked,
      applyError: persona?.applyError ?? null,
      test: applyTest,
    }),
    locked,
    showCall: comparing,
    setShowCall,
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
    // [통화에 반영] — 시험할 것이 없으면(시나리오 시험이 꺼진 환경 · 이미 모두 통과 · 프롬프트와 목소리가 그대로) 바로 반영 확인, 아니면 시험하고 반영 확인
    applyHead: () => {
      if (!persona) return
      if (!applyTest.on || applyTest.allPass || sameTalk) return askUse(persona.personaSeq)
      confirm.reset()
      applyTest.resetStart()
      setConfirming({ kind: 'test' })
    },
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
    confirmError: confirmErrorText(confirm.error, confirming?.kind),

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
    // 저장하면 새로 생긴 현재 버전(고친 내용)을 보여 줌. 반영은 띠의 [통화에 반영]으로 (새 안 — 저장 직후 확인 창 없음)
    finishEdit: () => {
      setVersion(null)
      setShowCall(false)
    },

    // 통화에 사용 중인 상담가는 늘 맨 위 (나머지는 서버가 준 순서 그대로)
    personas: items,
    // 머리 줄 (새 안 — 이름 · 배지 · 목소리 · [삭제] · [통화에 사용하기]는 탭에서 고른 상담가 것)
    current: items.find((p) => p.selected) ?? null,
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
      setShowCall(false)
    },
  }
}
