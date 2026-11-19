import { useEffect, useState } from 'react'
import { subscribeActiveCallCount } from '../api/activeCallApi'

/** 진행 통화 수 — 상단바 'N건 접수 중' (AppLayout이 로그인한 동안 한 연결)
 *  count null = 아직 못 받음 · live false = 20초 넘게 서버에서 아무것도 못 받음(스스로 다시 붙는 중, 숫자는 마지막 값 그대로) */
export function useActiveCallCount() {
  const [count, setCount] = useState<number | null>(null)
  const [live, setLive] = useState(true) // 처음엔 붙는 중 = 정상으로 봄
  useEffect(() => subscribeActiveCallCount({ count: setCount, live: setLive }), [])
  return { count, live }
}
