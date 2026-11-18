// '모두 통과하면 반영' 약속을 어떻게 할지 — 순수 함수 (applyPledge.test.ts). 약속 저장은 pledgeStore, 지켜보기는 useApplyAfterTest
import type { Scenario, VersionTest } from '@/features/persona/api/scenarioTestApi'
import type { Pledge } from './pledgeStore'
import { rowsOf, testOf } from './scenarioTest'

/** 약속한 상담가의 지금 상태 — 목록(personaMap Persona)에서 쓰는 칸만 */
interface Target {
  head: { version: number }
  appliedVersion: number
  applyingVersion: number | null
}

const WAIT_MS = 180_000 // 방금 건 시험이 목록에 보이길 기다리는 시간

/** 약속 하나를 어떻게 할지 — wait 기다림 · drop 버림 · apply 반영 */
export function pledgeStep(
  p: Pledge,
  persona: Target | undefined,
  tests: VersionTest[],
  scenarios: Scenario[],
  now: number,
): 'wait' | 'drop' | 'apply' {
  // 그새 다시 고쳤거나(현재 버전이 다름) 이미 반영됐거나 반영 중이면 지킬 약속이 없음
  if (
    !persona ||
    persona.head.version !== p.version ||
    persona.applyingVersion !== null ||
    persona.appliedVersion === p.version
  )
    return 'drop'
  const mine = tests.find((t) => t.personaSeq === p.personaSeq && t.version === p.version)
  if (mine?.status === 'running') return 'wait'
  // 방금 건 시험이 아직 목록에 안 보임 — 조금 기다리고, 끝내 안 보이면 시작되지 않은 것
  if ((mine?.startedAt ?? null) === p.before) return now - p.at < WAIT_MS ? 'wait' : 'drop'
  // 멈췄거나(일부만 시험) 실패가 있으면 담당자가 띠에서 정함
  const { state, shown } = testOf(tests, scenarios, { ...p, isHead: true }, null)
  return state === 'done' && !rowsOf(scenarios, null, shown).some((r) => r.now === 'fail')
    ? 'apply'
    : 'drop'
}
