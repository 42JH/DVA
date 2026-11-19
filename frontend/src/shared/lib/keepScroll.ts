// 뒤로 와도 보던 곳 그대로 (통화 상세에서 ‹ 누르면 목록이 맨 위로 가던 것)
// 화면은 창이 아니라 안쪽 상자가 스크롤됨 → 브라우저 기본 복원이 안 됨. 그래서 기록(location.key)마다 상자 위치를 기억해 둠
// 상세의 ‹ 는 링크라 새 기록을 쌓음 → 바로 전 기록이 그 목록이면 뒤로가기로 (필터 · 쪽 · 스크롤이 그대로)
import { useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { useLocation, useNavigationType } from 'react-router'

const saved = new Map<string, number>() // `${기록 key}:${상자 이름}` → scrollTop (새로고침하면 비워짐)
const entries: { key: string; path: string }[] = [] // 앱 안에서 지나온 기록 (새로고침 뒤부터)
let at = -1

/** 지나온 기록 줄 — AppLayout에서 한 번 */
export function useTrackHistory() {
  const { key, pathname } = useLocation()
  const type = useNavigationType()
  useEffect(() => {
    const i = entries.findIndex((e) => e.key === key)
    if (i >= 0)
      at = i // 뒤로 · 앞으로
    else if (type === 'REPLACE' && at >= 0) entries[at] = { key, path: pathname }
    else {
      entries.splice(at + 1, Infinity, { key, path: pathname })
      at = entries.length - 1
    }
  }, [key, pathname, type])
}

/** 바로 전 기록이 to와 같은 화면인가 — 그러면 ‹ 를 뒤로가기로 */
export const prevIs = (to: string) => at > 0 && entries[at - 1]?.path === to.split('?')[0]

/** 스크롤 상자의 위치를 이 기록에 기억 · 돌아오면 되돌림. 돌아온 것이면 true (도착 위치로 옮기는 코드가 덮지 않게)
 *  목록을 다시 받는 동안은 높이가 모자라 → 닿을 때까지 몇 초 다시 맞춤. 사람이 먼저 굴리면 그만 */
export function useKeepScroll(ref: RefObject<HTMLElement | null>, name: string) {
  const id = `${useLocation().key}:${name}`
  const [back] = useState(() => saved.has(id))
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const want = saved.get(id) ?? 0
    let left = want > 0 ? 300 : 0 // 남은 시도 프레임 (~5초)
    let raf = 0
    const fit = () => {
      el.scrollTop = want
      if (Math.abs(el.scrollTop - want) < 2 || --left <= 0) left = 0
      else raf = requestAnimationFrame(fit)
    }
    const stop = () => {
      left = 0
      cancelAnimationFrame(raf)
    }
    const save = () => left <= 0 && saved.set(id, el.scrollTop)
    if (left) fit()
    const hands = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
    el.addEventListener('scroll', save, { passive: true })
    hands.forEach((t) => el.addEventListener(t, stop, { passive: true }))
    return () => {
      stop()
      el.removeEventListener('scroll', save)
      hands.forEach((t) => el.removeEventListener(t, stop))
    }
  }, [ref, id])
  return back
}
