import { useEffect, useState } from 'react'
import { useBlocker } from 'react-router'

/** 저장 안 한 내용이 있으면 나가기를 한 번 막음 — 상담가 등록 · 수정 화면 공용
 * [취소] · 다른 화면 이동은 확인 창, 탭 닫기 · 새로고침은 브라우저 기본 창
 * saving: 저장 중 · 저장 후엔 화면 이동을 막지 않음 (저장이 끝나면 화면이 스스로 닫힘) */
export function useLeaveGuard(dirty: boolean, saving: boolean, onLeave: () => void) {
  const [asking, setAsking] = useState(false)
  const blocker = useBlocker(dirty && !saving)

  // 문구는 브라우저가 정함
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  return {
    cancel: () => (dirty ? setAsking(true) : onLeave()),
    confirmingDiscard: asking || blocker.state === 'blocked',
    discard: () => {
      setAsking(false)
      if (blocker.state === 'blocked') blocker.proceed()
      else onLeave()
    },
    keepEditing: () => {
      setAsking(false)
      if (blocker.state === 'blocked') blocker.reset()
    },
  }
}
