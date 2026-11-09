// 테이블 상자가 세로로 스크롤되는지 감지 — true면 상자에 data-scrollable을 걸어 CSS가 마지막 행 테두리를 숨김
import { useEffect, useState, type RefObject } from 'react'

export function useScrollable(ref: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  const [scrollable, setScrollable] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setScrollable(el.scrollHeight > el.clientHeight + 1)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, ...deps])
  return scrollable
}
