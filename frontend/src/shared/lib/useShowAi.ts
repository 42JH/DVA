// 통화 기록에서 AI 동작 줄을 보일지 — 한 번 끄면 다른 통화를 열어도 꺼진 채로 (이 브라우저에 기억)
import { useState } from 'react'

const KEY = 'show-ai-steps'

export function useShowAi() {
  const [on, setOn] = useState(() => localStorage.getItem(KEY) !== '0')
  const set = (v: boolean) => {
    localStorage.setItem(KEY, v ? '1' : '0')
    setOn(v)
  }
  return [on, set] as const
}
