import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useSession } from '@/shared/auth/useSession'
import { useVoiceOptions } from './useVoiceOptions'
import { useApplyTest } from './useApplyTest'
import { useKeptView } from './useKeptView'
import { bandView, historyRows, personaItems, pickedView, promptView } from './personaPageView'
import { callStateOf, editTargetOf, reuseDiff } from './personaVersions'
import { bandStep } from './personaBand'
import { usePersonaConfirm } from './usePersonaConfirm'
import { talksOf } from './scenarioTest'
import { SCENARIO_TEST } from '../api/scenarioTestApi'
import { personaQueries, type PersonaVersion } from '../api/personaApi'

const POLL_MS = 2000 // 적용 대기 중일 때만 다시 받는 간격 (AI 확인으로 서버 상태가 바뀌므로)
/** 07 AI 상담가 훅 (저장 = 새 버전)
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
  const [adding, setAdding] = useState(false)
  const options = useVoiceOptions() // 다시 쓰기에서 속도를 AI 지원 범위로 맞춰 보낼 때
  // 추가 · 수정 · 사용하기 · 삭제는 모든 관리자(OPERATOR · SYSTEM_ADMIN) — 11/11 백엔드 권한 이분화 ('OPERATOR는 보기만'을 뒤집음)
  // 내 정보를 불러오기 전(role undefined)에는 숨김
  const { role } = useSession()
  const canManage = role !== undefined

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
  const picked = historyOpen ? (all.find((v) => v.version === version) ?? head) : null
  // 목소리 값 → 이름 ('' = 기본 음성, AI 목록에 없으면 값 그대로)
  const voiceLabel = (v: string) => options.voiceOptions(v).find((o) => o.value === v)?.label ?? v

  // 불러올 것이 없음 = 고칠 시작점(남은 초안 · 현재 버전)과 내용이 같음
  const reuseSame = (v: PersonaVersion) =>
    !!latest && reuseDiff(v, latest).same && !persona?.draftRevision

  // 통화와의 관계 — 반영 전 띠 · 통화에 쓰는 버전 · 띠에서 시험하고 반영할 대상
  const call = callStateOf(persona, all, head)
  const { unapplied, callVersion, switching } = call
  const applyTest = useApplyTest(call.applyTarget, {
    auto: !switching,
    expected: call.banded,
    talks: talksOf(all),
  })
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
  const items = personaItems(list, { currentSeq: persona?.personaSeq, step, canManage })
  const confirm = usePersonaConfirm({
    persona,
    list,
    step,
    call,
    applyTest,
    // 지운 상담가를 보고 있었으면 통화에 사용 중인 상담가로 돌아감 (persona 계산이 못 찾으면 inUse로 넘김)
    onDeletedCurrent: () => {
      setPersonaSeq(null)
      setVersion(null)
      setHistoryOpen(false)
    },
  })

  // 수정 기록 창의 비교 기준 = 통화에 쓰는 내용 (안 쓰는 상담가는 appliedVersion = 현재 버전)
  const base = persona ? (all.find((v) => v.version === persona.appliedVersion) ?? head) : null

  return {
    isLoading: personas.isPending, // 처음 들어올 때만 화면 전체
    // 상담가를 바꿀 때 버전을 받는 동안은 가운데만 — 오른쪽 카드가 다시 그려지면 스크롤이 맨 위로 감
    promptLoading,
    error: personas.error || versions.error ? '불러오지 못했습니다. 다시 시도해 주세요.' : null,

    prompt:
      persona && head
        ? promptView(head, {
            callVersion,
            comparing,
            voice: voiceLabel(head.voice.voice),
            canEdit: canManage && !locked,
          })
        : null,

    // 수정 기록 창 — 왼쪽 날짜별 목록, 오른쪽은 통화에 쓰는 내용과 다른 칸만
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
    // 띠 — 반영 전 · 시험 중 · 반영 중. 고친 내용 = 반영 중이면 그 버전, 아니면 현재 버전
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

    // 확인 창 — [통화에 사용하기] · [삭제] · 띠의 [통화에 반영] · [시험 중단] · [확인하고 반영]
    ...confirm,

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
      SCENARIO_TEST && persona && head
        ? `/personas/${persona.personaSeq}/tests/${head.version}`
        : null,

    editTarget: editTargetOf(persona, latest),
    // 저장하면 새로 생긴 현재 버전(고친 내용)을 보여 줌. 반영은 띠의 [통화에 반영]으로 (저장 직후 확인 창 없음)
    finishEdit: () => {
      setVersion(null)
      setShowCall(false)
    },

    // 통화에 사용 중인 상담가는 늘 맨 위 (나머지는 서버가 준 순서 그대로)
    personas: items,
    // 머리 줄 (이름 · 배지 · 목소리 · [삭제] · [통화에 사용하기]는 탭에서 고른 상담가 것)
    current: items.find((p) => p.selected) ?? null,
    selectPersona: (seq: number) => {
      setPersonaSeq(seq)
      setVersion(null)
      setShowCall(false)
    },
  }
}
