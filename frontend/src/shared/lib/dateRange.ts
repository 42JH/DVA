// 달력 계산 — 화면(Calendar.tsx)과 분리해서 혼자 검증 가능
// 날짜는 'YYYY-MM-DD' 문자열로만 다룬다 (시간대 문제 없음). 서버로 보낼 때 from 포함 · to 미포함(명세서 1.2)이라 to는 다음 날

export type Ymd = string // '2026-10-20'

export const ymd = (d: Date): Ymd =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

export const todayYmd = (): Ymd => ymd(new Date())

/** 서버 기간 경계 — 그 날 한국 시각 00:00 (명세 §1: 시간대 포함 ISO, from 포함 · to 미포함 → to는 다음 날을 넣음) */
export const kstDayStart = (day: Ymd) => `${day}T00:00:00+09:00`

/** 'YYYY-MM-DD' + n일 */
export function addDays(s: Ymd, n: number): Ymd {
  const [y, m, d] = s.split('-').map(Number)
  return ymd(new Date(y, m - 1, d + n))
}

/** 달력 한 달의 칸 배열: 앞 빈칸(null) + 1..말일. 일요일 시작 */
export function monthGrid(year: number, month1: number): (number | null)[] {
  const firstDow = new Date(year, month1 - 1, 1).getDay()
  const days = new Date(year, month1, 0).getDate()
  return [...Array<null>(firstDow).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
}

/** 두 번 눌러 범위 고르기: 첫 클릭 = 시작, 둘째 = 끝(앞이면 뒤집음). 셋째 클릭은 새로 시작 */
export function pickRange(cur: { from?: Ymd; to?: Ymd }, day: Ymd): { from: Ymd; to?: Ymd } {
  if (!cur.from || cur.to) return { from: day }
  return day < cur.from ? { from: day, to: cur.from } : { from: cur.from, to: day }
}

/** 포함 일수 ('10.01 ~ 10.15' = 15일) */
export function rangeDays(from: Ymd, to: Ymd): number {
  const [a, b] = [from, to].map((s) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  })
  return Math.round((b - a) / 86_400_000) + 1
}

/** 기간 필터 값 → 서버 from · to (to 미포함). week = 오늘 포함 7일 */
export function periodToRange(
  period: 'today' | 'week' | 'custom',
  custom?: { from: Ymd; to: Ymd },
  today = todayYmd(),
) {
  if (period === 'today') return { from: today, to: addDays(today, 1) }
  if (period === 'week') return { from: addDays(today, -6), to: addDays(today, 1) }
  if (!custom) return null
  return { from: custom.from, to: addDays(custom.to, 1) }
}

/** 표시용 (10/30 연도 규칙): 올해면 'MM.DD', 하나라도 다른 해면 전부 'YYYY.MM.DD' — 같이 보이는 날짜는 같이 넘겨 연도 여부를 맞춤 */
function fmtYmds(days: Ymd[], today = todayYmd()): string[] {
  const withYear = days.some((s) => s.slice(0, 4) !== today.slice(0, 4))
  return days.map((s) => (withYear ? s : s.slice(5))) // 구분자는 '-' 그대로 (11/02 현업: 시간 ':'와 짝)
}

/** 'MM-DD ~ MM-DD' (달력 하단 · 02 버전 운영 기간) */
export const fmtRange = (from: Ymd, to: Ymd, today?: Ymd) => fmtYmds([from, to], today).join(' ~ ')
