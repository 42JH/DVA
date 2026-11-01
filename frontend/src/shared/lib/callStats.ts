// 통화 목록으로 화면에서 내는 평균 — 통계 API가 없어서 (명세 §10, 11/01). 02 대시보드 · 01 홈 공통
interface Timed {
  startedAt: string | null
  endedAt: string | null
}

export const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** 평균 통화 시간(초) — 시작 · 끝이 다 있고 끝이 시작보다 뒤인 통화만. 셀 통화가 없으면 null */
export function avgDurationSec(rows: Timed[]): number | null {
  return avg(
    rows.flatMap((r) => {
      if (!r.startedAt || !r.endedAt) return [] // 진행 중이거나 시각이 빠진 통화
      const s = (Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000
      return s >= 0 ? [s] : []
    }),
  )
}
