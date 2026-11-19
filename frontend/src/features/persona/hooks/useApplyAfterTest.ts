import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { personaQueries, requestApply } from '../api/personaApi'
import { SCENARIO_TEST, scenarioTestQueries } from '../api/scenarioTestApi'
import { pledgeStep } from './applyPledge'
import { pledges } from './pledgeStore'

/** '모두 통과하면 반영' 약속 지키기 — 앱 틀이 약속이 있을 때만 불러옴 (components/ApplyAfterTest)
 *  어느 화면에 있든 시험이 끝나면 반영. 시험 목록은 도는 동안 2초마다 다시 받음 (scenarioTestQueries.tests) */
export function useApplyAfterTest() {
  const raw = useSyncExternalStore(pledges.subscribe, pledges.raw)
  const list = useMemo(() => pledges.parse(raw), [raw])
  const on = SCENARIO_TEST && list.length > 0
  const personas = useQuery({ ...personaQueries.list(), enabled: on })
  const scenarios = useQuery({ ...scenarioTestQueries.scenarios(), enabled: on })
  const tests = useQuery({ ...scenarioTestQueries.tests(), enabled: on })
  const qc = useQueryClient()
  useEffect(() => {
    if (!on || !personas.data || !scenarios.data || !tests.data) return
    for (const p of list) {
      const persona = personas.data.find((x) => x.personaSeq === p.personaSeq)
      const step = pledgeStep(p, persona, tests.data, scenarios.data, Date.now())
      // take가 false = 다른 탭이 먼저 처리 (같은 반영 요청이 두 번 가지 않게)
      if (step === 'wait' || !pledges.take(p) || step === 'drop' || !persona) continue
      void requestApply(persona.personaSeq, persona.head)
        .catch(() => {}) // 실패하면 띠가 반영 전으로 남음 — [통화에 반영]이 시험 없이 다시 보냄
        .finally(() => qc.invalidateQueries({ queryKey: personaQueries.all() }))
    }
  }, [on, list, personas.data, scenarios.data, tests.data, qc])
}
