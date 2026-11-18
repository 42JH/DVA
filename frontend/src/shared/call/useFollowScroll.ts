import { useEffect, useRef, type RefObject } from 'react'

const PAUSE_MS = 3000 // 사람이 목록을 굴린 뒤 이만큼은 따라가지 않음

/** 그 줄(data-key)이 목록 가운데 오게 — 목록 안에서만 스크롤 (scrollIntoView는 바깥 틀까지 움직일 수 있어서) */
function center(list: HTMLElement | null, key: number) {
  const el = list?.querySelector<HTMLElement>(`[data-key="${key}"]`)
  if (!list || !el) return
  const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  list.scrollTo({
    top: top - (list.clientHeight - el.offsetHeight) / 2,
    behavior: reduce ? 'auto' : 'smooth',
  })
}

/** 멜론 가사처럼 (11/05 사용자): 재생 중이면 짚은 줄이 바뀔 때마다 목록 가운데로 부드럽게 넘어감
 *  사람이 휠 · 터치로 굴리면 3초 동안은 안 따라감(보던 곳을 빼앗지 않게). jump(이전 · 다음 · AI 동작)는 늘 그 줄로
 *  돌려주는 함수 = 사람이 굴렸다는 신호 (목록의 onWheel · onTouchMove에) */
export function useFollowScroll(
  ref: RefObject<HTMLElement | null>,
  key: number | null,
  follow: boolean,
  jump: { key: number; n: number } | null = null,
) {
  const touchedAt = useRef(0)
  useEffect(() => {
    if (follow && key !== null && Date.now() - touchedAt.current > PAUSE_MS)
      center(ref.current, key)
  }, [ref, key, follow])
  useEffect(() => {
    if (jump) center(ref.current, jump.key)
  }, [ref, jump])
  return () => {
    touchedAt.current = Date.now()
  }
}
