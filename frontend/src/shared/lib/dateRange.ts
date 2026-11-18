// 날짜 계산 — 화면과 분리해서 혼자 검증 가능
// 날짜는 'YYYY-MM-DD' 문자열로만 다룬다 (시간대 문제 없음). 서버로 보낼 때 from 포함 · to 미포함(명세서 1.2)이라 to는 다음 날

export type Ymd = string // '2026-10-20'

export const ymd = (d: Date): Ymd =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 오늘 — 한국 시각 기준 (서버 날짜 · 월 경계가 KST라 브라우저 시간대와 상관없이 맞춤) */
export const todayYmd = (now = Date.now()): Ymd =>
  new Date(now + 9 * 3_600_000).toISOString().slice(0, 10)

/** 'YYYY-MM'에서 n달 이동 — 해 넘김 포함 */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1 + n, 1)).toISOString().slice(0, 7)
}

/** 서버 기간 경계 — 그 날 한국 시각 00:00 (명세 §1: 시간대 포함 ISO, from 포함 · to 미포함 → to는 다음 날을 넣음) */
export const kstDayStart = (day: Ymd) => `${day}T00:00:00+09:00`

/** 'YYYY-MM-DD' + n일 */
export function addDays(s: Ymd, n: number): Ymd {
  const [y, m, d] = s.split('-').map(Number)
  return ymd(new Date(y, m - 1, d + n))
}
