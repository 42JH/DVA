import { fmtNum } from '@/shared/lib/format'
// 02 대시보드 숫자 · 문구 규칙 — 순수 함수 (format.test.ts). '@/' import 없음 (tsx로 바로 돌리려고)

/** 서버 숫자(0~100 비율 · 초) → 소수 한 자리. null(미측정 · 분모 0)은 '—' — 0과 다름 (연동 명세 §1) */
export const one = (n: number | null) => (n === null ? '—' : n.toFixed(1))
/** 0~100 비율 → '12.8%' (null은 '—') */
export const pctText = (p: number | null) => (p === null ? '—' : `${one(p)}%`)
/** 소수 두 자리 — 응답 대기의 초 중 카드 표 '평균 대기' · 그래프 보기 막대 위 숫자만. 나머지는 다 한 자리 (0.02초처럼 작은 값이라) */
export const two = (n: number | null) => (n === null ? '—' : n.toFixed(2))
/** 건수 → '1,800' */
export const num = fmtNum

/** 초 → '5시간 0분' · '45분' (응답 대기 합계) */
export function hoursMinutes(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor(sec / 60) % 60
  return h ? `${h}시간 ${m}분` : `${m}분`
}

/** 가장 큰 값의 자리 — 표에서 눈에 띄게 할 줄. 다 0이면 -1 (아무 줄도 안 칠함) */
export function maxIndex(values: number[]): number {
  const max = Math.max(0, ...values)
  return max ? values.indexOf(max) : -1
}

/** 막대그래프 세로축 눈금 — 1 · 2 · 2.5 · 5 × 10ⁿ 간격 5칸 이하, 맨 위는 최댓값보다 큼(값 글자 자리) (230 → 0 · 50 · … · 250) */
export function axisTicks(max: number): number[] {
  if (max <= 0) return [0, 1]
  const raw = max / 5
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw)!
  const top = (Math.floor(max / step) + 1) * step
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Number((i * step).toFixed(6)))
}

/** 현재 vs 직전 버전 한 줄 — diff = 직전 평균 - 현재 평균(초/건), 양수면 현재가 빠름 (명세 §3). 한쪽 평균이 없으면(null) 줄 없음 */
export function versionGap(diff: number | null): string | null {
  if (diff === null) return null
  const s = Math.abs(diff).toFixed(1)
  if (s === '0.0') return '현재 버전과 직전 버전의 접수 1건당 시간이 같았어요.'
  return `현재 버전이 직전 버전보다 접수 1건당 ${s}초 ${diff > 0 ? '짧았어요' : '길었어요'}.`
}
