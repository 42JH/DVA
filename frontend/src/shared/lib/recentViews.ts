import { useEffect, useSyncExternalStore } from 'react'

// 최근 조회 (11/05 사용자: 최근 검색어 대신) — 상단바 검색 창이 비었을 때 탭별로 보여 주고, 누르면 바로 그 상세로
// 상세를 열 때마다 남김 (검색 창에서 열든 목록에서 열든): 통화 상세 · 주문 상세 창 · FAQ 상세 · 기업 상세
// 탭(종류)마다 최대 20개(11/05 시안) · 최근이 위 · 이 브라우저에만. 고객 이름이 들어가서 로그아웃하면 전부 지움 (shared/auth/session)
// 상세가 '없음'(지워짐 · 404)이면 그 기록을 뺌
export type RecentKind = 'call' | 'order' | 'faq' | 'company'

export interface RecentView {
  kind: RecentKind
  id: number
  label: string // 통화 = 고객 이름 · 주문 = 보내는 분 · FAQ = 질문 · 기업 = 기업명
  to?: string // 주문 = 받는 분 ('DV-00001 보내는 분 ≫ 받는 분')
  sub?: string[] // 이름 뒤 흐린 글 — 통화 = [전화번호] · 기업 = [대표자 이름, 대표자 전화번호]
}

const KEY = 'dva.recentViews'
const MAX = 20
const KINDS: RecentKind[] = ['call', 'order', 'faq', 'company']

const valid = (v: unknown): v is RecentView => {
  const r = v as RecentView
  return !!r && KINDS.includes(r.kind) && Number.isInteger(r.id) && typeof r.label === 'string'
}

let cache: RecentView[] | null = null
const listeners = new Set<() => void>()

function read(): RecentView[] {
  if (cache) return cache
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    cache = Array.isArray(v) ? v.filter(valid) : []
  } catch {
    cache = [] // 저장소가 막혔거나 값이 깨졌으면 없는 것으로
  }
  return cache
}

function write(next: RecentView[]) {
  cache = next
  try {
    if (next.length) localStorage.setItem(KEY, JSON.stringify(next))
    else localStorage.removeItem(KEY)
  } catch {
    // 못 저장해도 이번 창에서는 보임
  }
  listeners.forEach((l) => l())
}

const same = (a: RecentView, kind: RecentKind, id: number) => a.kind === kind && a.id === id

/** 맨 위로 올림 (이미 맨 위에 같은 내용이면 그대로) */
export function rememberView(v: RecentView) {
  const all = read()
  const first = all.find((x) => x.kind === v.kind)
  if (
    first &&
    same(first, v.kind, v.id) &&
    first.label === v.label &&
    first.to === v.to &&
    String(first.sub) === String(v.sub)
  )
    return
  const rest = all.filter((x) => !same(x, v.kind, v.id))
  const mine = [v, ...rest.filter((x) => x.kind === v.kind)].slice(0, MAX)
  write([...mine, ...rest.filter((x) => x.kind !== v.kind)])
}

export function forgetView(kind: RecentKind, id: number) {
  if (read().some((x) => same(x, kind, id))) write(read().filter((x) => !same(x, kind, id)))
}

/** kind를 주면 그 탭만 (검색 창 '전체 삭제'), 안 주면 전부 (세션이 끝날 때) */
export function clearRecentViews(kind?: RecentKind) {
  write(kind ? read().filter((x) => x.kind !== kind) : [])
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** 지금 기록 전부 (시험용) */
export const recentViewsNow = (): readonly RecentView[] => read()

/** 검색 창 — 그 탭의 최근 조회 (최근이 위) */
export function useRecentViews(kind: RecentKind): RecentView[] {
  return useSyncExternalStore(subscribe, read).filter((x) => x.kind === kind)
}

/** 상세 화면 — 내용이 보이면 기록, '없음'이면 기록에서 뺌 */
export function useRememberView(
  kind: RecentKind,
  id: number,
  view: { label: string; to?: string; sub?: string[] } | null,
  gone = false,
) {
  const label = view?.label
  const to = view?.to
  const sub = view?.sub?.length ? JSON.stringify(view.sub) : undefined // 배열은 렌더마다 새 것이라 글로 바꿔 비교
  useEffect(() => {
    if (gone) forgetView(kind, id)
    else if (label !== undefined)
      rememberView({ kind, id, label, to, sub: sub ? (JSON.parse(sub) as string[]) : undefined })
  }, [kind, id, label, to, sub, gone])
}
