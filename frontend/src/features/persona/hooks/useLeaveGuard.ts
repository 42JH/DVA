import { useEffect, useState } from 'react'
import { useBlocker } from 'react-router'

/** 저장 안 한 내용이 있으면 나가기를 한 번 막음 — 상담가 등록 · 수정 화면 공용
 * [취소] · 다른 화면 이동은 확인 창, 탭 닫기 · 새로고침은 브라우저 기본 창
 * saving: 저장 중 · 저장 후엔 화면 이동을 막지 않음 (저장이 끝나면 화면이 스스로 닫힘) */
export function useLeaveGuard(dirty: boolean, saving: boolean, onLeave: () => void) {
  // 확인 창이 떠 있으면 [나가기] 때 할 일 — [취소]는 onLeave, 같은 화면 안 이동(상담가 탭 등)은 그 이동
  const [asking, setAsking] = useState<(() => void) | null>(null)
  const blocker = useBlocker(dirty && !saving)

  // 문구는 브라우저가 정함
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return {
    cancel: () => (dirty ? setAsking(() => onLeave) : onLeave()),
    // 라우터가 못 막는 같은 화면 안 이동 — 고친 게 있으면 물은 뒤 next
    leave: (next: () => void) => (dirty ? setAsking(() => next) : next()),
    confirmingDiscard: asking !== null || blocker.state === 'blocked',
    discard: () => {
      setAsking(null)
      if (blocker.state === 'blocked') blocker.proceed()
      else asking?.()
    },
    keepEditing: () => {
      setAsking(null)
      if (blocker.state === 'blocked') blocker.reset()
    },
  }
}
