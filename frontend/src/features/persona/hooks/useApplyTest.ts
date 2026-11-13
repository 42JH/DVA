import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { personaQueries, requestApply } from '@/features/persona/api/personaApi'
import {
  SCENARIO_TEST,
  scenarioTestQueries,
  startTest,
} from '@/features/persona/api/scenarioTestApi'
import { restOf, rowsOf, testOf } from './scenarioTest'

/** 통화에 반영할 버전 — 사용 중 상담가의 고친 내용(현재 버전) */
export type ApplyTarget = {
  personaSeq: number
  head: { seq: number; version: number }
  promptText: string
  voiceId: string | null
}

// '모두 통과하면 반영' 약속 — 시험이 도는 동안만 남음. 브라우저마다 따로(서버엔 이 개념이 없음)
// ponytail: 시험을 건 브라우저가 열려 있어야 저절로 반영됨. 닫혀 있었으면 띠의 [통화에 반영]이 바로 반영(모두 통과 상태라 시험 없음)
const KEY = 'personas:applyAfterTest'
const read = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]
  } catch {
    return []
  }
}
const write = (tags: string[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(tags))
  } catch {
    // 못 쓰면 저절로 반영만 안 됨
  }
}
const tagOf = (t: ApplyTarget) => `${t.personaSeq}:${t.head.version}`

/** 띠의 시험 → 반영 (11/13 새 안 1번, 피그마 2368:3023 · 3212 · 3388)
 *  [통화에 반영] → 그 버전 시험 상태에 따라: 모두 통과 = 바로 반영 / 아니면 시험하고 반영(못 한 것만 — 일부 시험이면 남은 것)
 *  시험이 끝나 모두 통과 + 이 브라우저가 건 시험이면 저절로 반영. 실패가 있으면 확인 필요 띠(담당자가 정함) */
// auto false = 모두 통과해도 저절로 반영하지 않음 (6번 다른 상담가를 통화에 쓰기 — 담당자가 [통화에 사용하기])
export function useApplyTest(target: ApplyTarget | null, { auto = true }: { auto?: boolean } = {}) {
  const on = SCENARIO_TEST && target !== null
  const qc = useQueryClient()
  const scenarios = useQuery({ ...scenarioTestQueries.scenarios(), enabled: on })
  const tests = useQuery({ ...scenarioTestQueries.tests(), enabled: on })
  const list = scenarios.data ?? []
  const me = target && { personaSeq: target.personaSeq, version: target.head.version, isHead: true }
  const { state, shown } = me
    ? testOf(tests.data ?? [], list, me, null)
    : { state: 'none' as const, shown: null }
  // 고치기 전 글의 결과(stale)는 이 버전 것이 아님 → 시험 전과 같음
  const rows = rowsOf(list, null, state === 'stale' ? null : shown)
  const count = (c: string) => rows.filter((r) => r.now === c).length
  const pass = count('pass')
  const fail = count('fail')
  const error = count('error')
  const rest = restOf(state, rows)
  const allPass = state === 'done' && fail === 0

  const apply = useMutation({
    mutationFn: (t: ApplyTarget) => requestApply(t.personaSeq, t.head),
    onSettled: () => qc.invalidateQueries({ queryKey: personaQueries.all() }),
  })
  const start = useMutation({
    mutationFn: async (t: ApplyTarget) => {
      await startTest({
        personaSeq: t.personaSeq,
        version: t.head.version,
        promptText: t.promptText,
        voiceId: t.voiceId,
        scenarios: rest.length ? rest : undefined, // 일부만 시험했으면 남은 것만(요금)
      })
    },
    // 목록을 다시 받은 뒤(시험 중이 보인 뒤)에 약속을 남김 — 먼저 남기면 옛 목록(시험 전)을 보고 바로 지워짐
    onSuccess: async (_, t) => {
      await qc.invalidateQueries({ queryKey: scenarioTestQueries.tests().queryKey })
      if (auto) write([...read().filter((x) => x !== tagOf(t)), tagOf(t)])
    },
    // 응답을 못 받아도 창구는 걸기 시작했을 수 있음 → 다시 보내지 않고 목록만 다시 받음 (시험 중이면 띠가 시험 중으로 바뀜)
    onError: () => qc.invalidateQueries({ queryKey: scenarioTestQueries.tests().queryKey }),
  })

  // 시험이 끝나면 약속을 지움 — 모두 통과면 그때 반영. 한 번만 (2초마다 다시 그려짐)
  const fired = useRef('')
  useEffect(() => {
    if (state === 'running') fired.current = '' // 다시 시험하고 반영(2번)도 끝나면 한 번 더
    if (!target || !tests.data || !scenarios.data || state === 'running') return
    const tag = tagOf(target)
    if (!read().includes(tag) || fired.current === tag) return
    fired.current = tag
    write(read().filter((x) => x !== tag))
    if (allPass) apply.mutate(target)
  }, [target, tests.data, scenarios.data, state, allPass, apply])

  return {
    on,
    state,
    total: list.length,
    pass,
    fail,
    error,
    ended: pass + fail + error,
    allPass,
    // 시험 중단 띠 (2번) — 이 버전의 마지막 묶음이 다 못 돌고 멈춤(관리자 · 창구 꺼짐). 연결 실패만 남은 '일부 시험'은 아님
    stopped:
      state === 'partial' && (shown?.status === 'stopped' || shown?.status === 'interrupted')
        ? { at: shown.startedAt }
        : null,
    toRun: rest.length || list.length, // 확인 창의 'N개를 돌립니다'
    resume: rest.length > 0,
    start: (t: ApplyTarget) => start.mutateAsync(t),
    starting: start.isPending,
    startError: start.isError
      ? '시작을 확인하지 못했습니다. 띠가 시험 중으로 바뀌지 않을 때만 다시 시도해 주세요.'
      : null,
    resetStart: start.reset,
    apply: (t: ApplyTarget) => apply.mutateAsync(t),
    applyError: apply.isError ? '통화에 반영하지 못했습니다. 다시 시도해 주세요.' : null,
  }
}
