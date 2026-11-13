import { useEffect, useRef, type RefObject } from 'react'

/** 사라지는 요소에 퇴장 애니메이션 (11/01 사용자: 팝업 · 펼침이 "뚝" 꺼지지 않게)
 *  React는 부모가 지우는 순간 DOM을 바로 떼므로, 붙을 때 요소 · 부모 · 자리를 기억해 뒀다가 떼인 뒤 복제본을 그 자리에 두고 퇴장 애니메이션이 끝나면 치움
 *  → 창을 여는 쪽(onClose로 바로 지우는 코드)은 고칠 게 없음. 복제본은 inert(누를 수 없음)
 *  이 훅은 "요소와 함께 떼이는 컴포넌트" 안에서 불러야 함 (Dialog.tsx의 Overlay)
 *  swap: [복제본에서 뺄 등장 클래스, 대신 넣을 퇴장 클래스] 목록 — 뿌리와 자식 전부에서 바꿈. 모듈 상수로 줄 것(렌더마다 새 배열이면 매번 다시 걺)
 *  개발 모드 StrictMode 가 마운트 직후 한 번 떼었다 붙이는 건 건너뜀(마운트 100ms 안). 움직임 줄이기 설정이면 복제본을 안 만듦 */
export function useExitGhost(
  ref: RefObject<HTMLElement | null>,
  swap: readonly (readonly [string, string])[],
  ms = 200,
) {
  const mountedAt = useRef(0)
  useEffect(() => {
    mountedAt.current = performance.now()
    const el = ref.current // 뗄 때는 DOM에서 이미 빠진 뒤라 붙을 때 자리를 기억
    const parent = el?.parentElement ?? null
    const next = el?.nextSibling ?? null
    return () => {
      if (!el || !parent?.isConnected || performance.now() - mountedAt.current < 100) return
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
      const ghost = el.cloneNode(true) as HTMLElement
      ghost.inert = true
      ghost.setAttribute('aria-hidden', 'true')
      for (const n of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')]) {
        let swapped = false
        for (const [from, to] of swap)
          if (n.classList.contains(from)) {
            n.classList.replace(from, to)
            swapped = true
          }
        // 복제본은 새 요소라 안쪽의 등장 애니메이션(달력 판 슬라이드 · 떠오름)이 처음부터 다시 돎 → 퇴장만 남기고 전부 멈춤
        if (!swapped) n.style.animation = 'none'
      }
      parent.insertBefore(ghost, next?.parentElement === parent ? next : null)
      setTimeout(() => ghost.remove(), ms)
    }
  }, [ref, swap, ms])
}
