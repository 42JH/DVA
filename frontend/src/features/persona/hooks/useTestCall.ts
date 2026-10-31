import { useEffect, useState } from 'react'
import { fmtClock } from '@/shared/lib/format'
import { fakeTestCallScript } from '@/features/persona/api/personaApi'

export interface TestCallTarget {
  personaSeq: number
  version: number
  subtitle: string // '빠른 접수형 v7 (저장됨) · marin · 빠르게'
}

/** 07 시험 통화 훅 (와이어프레임 07_페르소나관리_시험통화, 10/31) — 열리면 바로 통화 시작, 1초마다 시간 · 그때까지 나온 말
 * [통화 끝내기] · ✕ · Esc = 끝냄 → 걸린 초를 돌려줌 (버전 히스토리에 '시험 통화 완료 · 01:12') */
export function useTestCall(target: TestCallTarget, onEnd: (seconds: number) => void) {
  const [script] = useState(fakeTestCallScript)
  const [startedAt] = useState(() => Date.now())
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    // 화면이 가려져 setInterval이 늦어져도 시간이 밀리지 않게 시작 시각과의 차이로 셈
    const id = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    )
    return () => window.clearInterval(id)
  }, [startedAt])

  return {
    subtitle: target.subtitle,
    clock: fmtClock(seconds),
    lines: script
      .filter((l) => l.atSec <= seconds)
      .map((l) => ({
        key: `${l.atSec}-${l.speaker}`,
        who: l.speaker === 'AI' ? 'AI' : '나',
        isAi: l.speaker === 'AI',
        text: l.text,
        time: fmtClock(l.atSec),
      })),
    end: () => onEnd(seconds),
  }
}
