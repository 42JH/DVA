// '모두 통과하면 반영' 약속 (11/13 새 안 1번) — 시험을 건 브라우저에 남김 (서버엔 이 개념이 없음)
// 앱 틀(AppLayout)은 약속이 있는지만 보고, 있을 때만 지켜보는 코드(ApplyAfterTest)를 불러옴 → 이 파일은 다른 모듈을 끌어오지 않게 둠
// ponytail: 브라우저가 열려 있어야 함. 닫혀 있었으면 다음에 열 때 반영 — 서버가 약속을 맡게 되면 이 파일을 지움
import { useSyncExternalStore } from 'react'

export interface Pledge {
  personaSeq: number
  version: number
  before: string | null // 시작 전 이 버전의 마지막 시험 시각 — 방금 건 시험이 목록에 보이는지 가림
  at: number // 약속한 때 (이 브라우저 시계)
}

const KEY = 'personas:applyAfterTest'
const CHANGED = 'personas:pledge' // 같은 탭에 알림 (storage 이벤트는 다른 탭에만 감)
const same = (a: Omit<Pledge, 'at'>, b: Pledge) =>
  a.personaSeq === b.personaSeq && a.version === b.version
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
    write([...pledges.parse(pledges.raw()).filter((x) => !same(p, x)), { ...p, at: Date.now() }])
  },
  /** 약속을 꺼냄 — 이미 없으면(다른 탭이 먼저 처리) false */
  take(p: Pledge): boolean {
    const list = pledges.parse(pledges.raw())
    if (!list.some((x) => same(p, x))) return false
    write(list.filter((x) => !same(p, x)))
    return true
  },
}

/** 지킬 약속이 있는가 — 앱 틀이 지켜보는 코드를 불러올지 정함 */
export const useHasPledge = () =>
  pledges.parse(useSyncExternalStore(pledges.subscribe, pledges.raw)).length > 0
