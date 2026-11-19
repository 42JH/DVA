// 담당자 이름을 칸 폭에 맞게 — 들어가는 만큼 이름, 넘치면 끝에 '외 n명' ('…'로 자르지 않음, 인원 제한 없음)
// 글자 폭은 canvas로 잼 (표 글꼴 14px Pretendard). 칸 폭은 화면이 바뀌면 ResizeObserver로 다시
import { useLayoutEffect, useRef, useState } from 'react'

let ctx: CanvasRenderingContext2D | null = null
const width = (s: string, font: string) => {
  ctx ??= document.createElement('canvas').getContext('2d')
  if (!ctx) return s.length * 14 // canvas가 없으면(테스트) 글자 수로 어림
  ctx.font = font
  return ctx.measureText(s).width
}

/** 들어가는 만큼 이름 + '외 n명' — 순수 함수(폭 재는 함수만 받음) */
export function fitNames(names: string[], max: number, measure: (s: string) => number): string {
  const all = names.join(', ')
  if (names.length <= 1 || measure(all) <= max) return all
  for (let k = names.length - 1; k >= 1; k--) {
    const s = `${names.slice(0, k).join(', ')} 외 ${names.length - k}명`
    if (measure(s) <= max) return s
  }
  return `${names[0]} 외 ${names.length - 1}명`
}

/** 칸 요소에 ref를 달면 그 폭 · 글꼴에 맞춘 글을 돌려줌 */
export function useFitNames(names: string[]) {
  const ref = useRef<HTMLElement>(null)
  const [box, setBox] = useState({ max: Infinity, font: '14px Pretendard' })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() =>
      setBox({ max: el.clientWidth, font: getComputedStyle(el).font }),
    )
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, fitNames(names, box.max, (s) => width(s, box.font))] as const
}
