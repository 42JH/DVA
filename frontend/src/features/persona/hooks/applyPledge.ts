// '모두 통과하면 반영' 약속 (11/13 새 안 1번) — 시험을 건 브라우저에 남김 (서버엔 이 개념이 없음)
// 앱 틀(useApplyAfterTest)이 지켜봐서 AI 상담가 화면을 떠나 있어도 시험이 끝나면 반영함 — 실제 시험은 10~25분이라 그동안 다른 메뉴를 봄
// ponytail: 브라우저가 열려 있어야 함. 닫혀 있었으면 다음에 열 때 반영 — 서버가 약속을 맡게 되면 이 파일을 지움
import type { Scenario, VersionTest } from '@/features/persona/api/scenarioTestApi'
import { rowsOf, testOf } from './scenarioTest'

export interface Pledge {
  personaSeq: number
  version: number
  before: string | null // 시작 전 이 버전의 마지막 시험 시각 — 방금 건 시험이 목록에 보이는지 가림
  at: number // 약속한 때 (이 브라우저 시계)
}

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

const KEY = 'personas:applyAfterTest'
const CHANGED = 'personas:pledge' // 같은 탭에 알림 (storage 이벤트는 다른 탭에만 감)
const same = (a: Pledge, b: Pledge) => a.personaSeq === b.personaSeq && a.version === b.version
const write = (list: Pledge[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
    window.dispatchEvent(new Event(CHANGED))
  } catch {
    // 못 쓰면 저절로 반영만 안 됨 — 띠의 [통화에 반영]으로
  }
}

export const pledges = {
  subscribe(onChange: () => void) {
    window.addEventListener('storage', onChange)
    window.addEventListener(CHANGED, onChange)
    return () => {
      window.removeEventListener('storage', onChange)
      window.removeEventListener(CHANGED, onChange)
    }
  },
  /** 저장된 글 그대로 — 바뀌었는지만 가림 */
  raw(): string {
    try {
      return localStorage.getItem(KEY) ?? '[]'
    } catch {
      return '[]'
    }
  },
  parse(raw: string): Pledge[] {
    try {
      const list: unknown = JSON.parse(raw)
      // 예전 모양('1:8' 글자)은 버림
      return Array.isArray(list)
        ? list.filter(
            (x): x is Pledge =>
              typeof x?.personaSeq === 'number' &&
              typeof x.version === 'number' &&
              typeof x.at === 'number',
          )
        : []
    } catch {
      return []
    }
  },
  /** 약속을 남김 — 때(at)는 여기서 찍음 */
  add(p: Omit<Pledge, 'at'>) {
    const next = { ...p, at: Date.now() }
    write([...pledges.parse(pledges.raw()).filter((x) => !same(x, next)), next])
  },
  /** 약속을 꺼냄 — 이미 없으면(다른 탭이 먼저 처리) false */
  take(p: Pledge): boolean {
    const list = pledges.parse(pledges.raw())
    if (!list.some((x) => same(x, p))) return false
    write(list.filter((x) => !same(x, p)))
    return true
  },
}
