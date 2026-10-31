import { useState } from 'react'

// 최근 검색어 (10/30 결정: 09 FAQ 목록 · AI 미답변만) — 화면별 이름으로 이 브라우저에만 저장, 최대 5개, 최근 것이 위
// 04 통화 내역 · 01 홈은 쓰지 않음 (검색어가 고객 이름 · 전화번호 = 개인정보). 같은 이유로 숫자만 친 검색어(전화번호)는 안 남기고,
// 로그아웃하면 전부 지움 (AI 미답변 검색칸에도 이름이 들어갈 수 있어서)
const MAX = 5
const PREFIX = 'dva.recent.'

function load(key: string): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PREFIX + key) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : []
  } catch {
    return [] // 저장소가 막혔거나 값이 깨졌으면 없는 것으로
  }
}

/** 세션이 끝날 때 (shared/auth/session의 clearSession — 로그아웃 · 401 · 만료) */
export function clearRecentSearches(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k)
  } catch {
    // 저장소가 막혀 있으면 지울 것도 없음
  }
}

/** key가 없으면 꺼짐 (목록 빈 배열, 저장 안 함) — 검색칸이 옵션으로 켤 수 있게 */
export function useRecentSearches(key?: string) {
  const [items, setItems] = useState(() => (key ? load(key) : []))
  const save = (next: string[]) => {
    if (!key) return
    setItems(next)
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(next))
    } catch {
      // 못 저장해도 이번 화면에서는 보임
    }
  }
  return {
    items,
    add: (text: string) => {
      const t = text.trim()
      if (!key || !t || /^[\d\s-]+$/.test(t)) return
      save([t, ...items.filter((x) => x !== t)].slice(0, MAX))
    },
    remove: (text: string) => save(items.filter((x) => x !== text)),
    clear: () => save([]),
  }
}
