import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ApiError } from '@/shared/api/client'
import { useShell } from '@/shared/lib/shell'
import { unsupportedText } from '../labels'
import type { useApplyTest } from './useApplyTest'
import type { callStateOf } from './personaVersions'
import { confirmCopy, type BandStep, type Confirming } from './personaBand'
import { scenarioTestQueries, stopTest } from '../api/scenarioTestApi'
import { deletePersona, personaQueries, requestApply } from '../api/personaApi'
import type { Persona } from '../api/personaMap'

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

type CallState = ReturnType<typeof callStateOf>

/** AI 상담가 화면의 확인 창 — [통화에 사용하기] · [삭제] · 띠의 [통화에 반영] · [시험 중단] · [확인하고 반영]
 *  어떤 창을 열지 고르고, [확인]이면 그 요청을 보내고, 창에 쓸 문구 · 오류를 만듦 */
export function usePersonaConfirm(s: {
  persona: Persona | null // 탭에서 고른 상담가
  list: Persona[]
  step: BandStep
  call: CallState
  applyTest: ReturnType<typeof useApplyTest>
  onDeletedCurrent: () => void // 보고 있던 상담가를 지웠을 때
}) {
  const { persona, list, step, applyTest } = s
  const { applyTarget, switching, sameTalk } = s.call
  const [confirming, setConfirming] = useState<Confirming>(null)
  const qc = useQueryClient()
  const { liveCalls } = useShell() // 바꾸기 확인 창 '지금 통화 중인 n건은 바뀌지 않습니다' (6번)

  const send = useMutation({
    mutationFn: async (c: NonNullable<Confirming>) => {
      switch (c.kind) {
        case 'use': {
          const target = list.find((p) => p.personaSeq === c.personaSeq)
          if (target) await requestApply(target.personaSeq, target.head)
          return
        }
        case 'delete':
          return deletePersona(c.personaSeq)
        case 'test':
          if (applyTarget) await applyTest.start(applyTarget)
          return
        case 'review':
          if (applyTarget) await applyTest.apply(applyTarget) // 반영되면 띠가 반영 중으로
          return
        case 'stop':
          if (!applyTarget) return
          // 실패해도 목록을 다시 받음(일부 묶음만 멈췄을 수 있음). 멈추면 띠가 시험 중단으로 바뀜 (저절로 반영 약속은 useApplyTest가 지움)
          try {
            await stopTest({
              personaSeq: applyTarget.personaSeq,
              version: applyTarget.head.version,
            })
          } finally {
            await qc.invalidateQueries({ queryKey: scenarioTestQueries.tests().queryKey })
          }
      }
    },
    onSuccess: async (_, c) => {
      await qc.invalidateQueries({ queryKey: personaQueries.all() })
      setConfirming(null)
      if (c.kind === 'delete' && c.personaSeq === persona?.personaSeq) s.onDeletedCurrent()
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

  // 창을 열 때마다 지난번 실패 문구를 지움 (새 창에 먼저 뜨지 않게)
  const open = (c: NonNullable<Confirming>) => {
    send.reset()
    setConfirming(c)
  }
  const askTest = () => {
    applyTest.resetStart()
    open({ kind: 'test' })
  }
  // 6번 — 다른 상담가로 바꿀 때 시험 전 · 실패 · 중단이면 시험부터 (모두 통과면 바로 바꾸기 확인)
  const askUse = (seq: number) => {
    if (switching && seq === persona?.personaSeq && applyTest.on && step !== 'passed')
      return askTest()
    open({ kind: 'use', personaSeq: seq })
  }

  return {
    confirm: confirmCopy(confirming, {
      step,
      current: persona,
      inUseName: list.find((p) => p.inUse)?.name ?? null,
      liveCalls,
      sameTalk,
      test: applyTest,
      find: (seq) => list.find((p) => p.personaSeq === seq),
    }),
    askUse,
    askDelete: (seq: number) => open({ kind: 'delete', personaSeq: seq }),
    askStop: () => open({ kind: 'stop' }), // [시험 중단] (2번)
    askReview: () => open({ kind: 'review' }), // [확인하고 반영] — 실패를 보고도 반영 (4번)
    // [통화에 반영] — 시험할 것이 없으면(시나리오 시험이 꺼진 환경 · 이미 모두 통과 · 프롬프트와 목소리가 그대로) 바로 반영 확인, 아니면 시험하고 반영
    applyHead: () => {
      if (!persona) return
      if (!applyTest.on || applyTest.allPass || sameTalk) return askUse(persona.personaSeq)
      askTest()
    },
    confirmOk: () => confirming && send.mutate(confirming),
    confirmCancel: () => setConfirming(null),
    confirmBusy: send.isPending,
    confirmError: confirmErrorText(send.error, confirming?.kind),
  }
}
