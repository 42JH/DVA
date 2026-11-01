// 날짜 · 번호 표시 규칙 (와이어프레임 10/23 결정 #7)
// 목록의 활동 시각 = 'MM.DD HH:MM' · 오래 남는 날짜(등록일 · 가입 신청일 · 버전 생성일) = 'YYYY.MM.DD'
// 상세 화면의 시각 = 'MM.DD (요일) HH:MM' (06 · 05 상세) — 서버는 ISO 8601(타임존 포함), 화면은 Asia/Seoul
// 10/30 연도 규칙 (모든 페이지): 올해면 연도 생략, 다른 해(작년 포함)면 'YYYY.MM.DD' → 새 목록은 fmtListTime

const two = (n: number) => String(n).padStart(2, '0')
const DAY = ['일', '월', '화', '수', '목', '금', '토']

/** 날짜 + 요일 (10/30 연도 규칙): 올해 '10.02 (금)', 다른 해 '2025.12.29 (월)' — 02 버전 운영 기간. year = 연도 강제 */
export function fmtDay(iso: string, now = new Date(), year?: boolean): string {
  return fmtDetailTime(iso, { now, year }).slice(0, -6) // 'HH:MM' 앞 공백까지 뗌
}

/** 기간 양 끝 날짜 + 요일: 한쪽이라도 다른 해면 양쪽 다 연도 (02 페르소나별 오른쪽 위) */
export function fmtDayRange(from: string, to: string, now = new Date()): string {
  const year = [from, to].some((s) => new Date(s).getFullYear() !== now.getFullYear())
  return `${fmtDay(from, now, year)} ~ ${fmtDay(to, now, year)}`
}

/** 상세 화면 시각 (10/30 연도 규칙): 올해 '10.20 (화) 13:12', 다른 해 '2025.12.29 (월) 13:12'. seconds면 '13:12:08' (06 통화 시작 시각)
 * year를 주면 그대로 (기간처럼 여러 날짜의 연도 표시를 맞출 때) */
export function fmtDetailTime(
  iso: string,
  {
    seconds = false,
    now = new Date(),
    year,
  }: { seconds?: boolean; now?: Date; year?: boolean } = {},
): string {
  const d = new Date(iso)
  const date =
    (year ?? d.getFullYear() !== now.getFullYear())
      ? fmtDate(iso)
      : `${two(d.getMonth() + 1)}.${two(d.getDate())}`
  const time = `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ''}`
  return `${date} (${DAY[d.getDay()]}) ${time}`
}

/** 목록 시각 칸 (10/30 연도 규칙): 올해면 ['10.20 14:33'] 한 줄, 다른 해면 ['2025.12.29', '13:40'] 날짜 위 · 시각 아래 두 줄 (칸 폭 그대로) */
export function fmtListTime(iso: string, now = new Date()): [string] | [string, string] {
  const d = new Date(iso)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return d.getFullYear() === now.getFullYear()
    ? [`${two(d.getMonth() + 1)}.${two(d.getDate())} ${hm}`]
    : [fmtDate(iso), hm]
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return `${two(d.getMonth() + 1)}.${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

export function fmtDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())}`
}

export function fmtDateTimeDay(iso: string): string {
  const d = new Date(iso)
  return `${two(d.getMonth() + 1)}.${two(d.getDate())} (${DAY[d.getDay()]}) ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** 초 → '3분 40초', 한 시간부터 '1시간 5분 03초' (04 통화 시간 · 02 평균 · CSV) */
export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  return `${h ? `${h}시간 ` : ''}${Math.floor(seconds / 60) % 60}분 ${two(seconds % 60)}초`
}

/** 초 → 큰 숫자 · 작은 단위로 나눈 조각 [['3', '분'], ['40', '초']] (02 평균 카드 · 01 홈 평균) */
export function fmtDurationParts(seconds: number): [string, string][] {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600) // 한 시간 넘으면 '1시간 5분 03초' (11/02)
  return [
    ...(h ? ([[String(h), '시간']] as [string, string][]) : []),
    [String(Math.floor(s / 60) % 60), '분'],
    [two(s % 60), '초'],
  ]
}

/** 초 → '03:40', 한 시간부터 '1:05:03' (06 통화 안 시각 · 재생 바) */
export function fmtClock(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  return `${h ? `${h}:` : ''}${two(Math.floor(seconds / 60) % 60)}:${two(seconds % 60)}`
}

/** 숫자 문자열 전화번호 → 010-1234-5678 (명세서: 전달 · 저장은 숫자만) */
export function fmtPhone(digits: string): string {
  const d = digits.replace(/\D/g, '')
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
  return digits
}

/** '10.20 (화)' (01 홈 '오늘' 기준일) */
export function fmtDateDay(d: Date): string {
  return `${two(d.getMonth() + 1)}.${two(d.getDate())} (${DAY[d.getDay()]})`
}

/** Date → datetime-local 칸 값 'YYYY-MM-DDTHH:mm' (브라우저 시간대 = 화면 시간대) */
export function toDateTimeLocal(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`
}

/** datetime-local 칸 값 → 서버로 보낼 ISO 8601 (UTC) */
export function fromDateTimeLocal(value: string): string {
  return new Date(value).toISOString()
}

/** 비율 묶음 ['85%', '10%', '5%'] — 따로 반올림하면 합이 99 · 101이 되므로 최대 나머지법으로 합을 100에 맞춤 (02 게이지 줄 · 버전별 기록). 합이 0이면 전부 '—' */
export function fmtPctSplit(values: number[], digits = 0): string[] {
  const of = values.reduce((a, b) => a + b, 0)
  if (!of) return values.map(() => '—')
  const unit = 10 ** digits
  const raw = values.map((v) => (v / of) * 100 * unit)
  const out = raw.map(Math.floor)
  const byRemainder = raw.map((_, i) => i).sort((a, b) => raw[b] - out[b] - (raw[a] - out[a]))
  let left = 100 * unit - out.reduce((a, b) => a + b, 0)
  for (const i of byRemainder) if (left-- > 0) out[i]++
  return out.map((n) => `${(n / unit).toFixed(digits)}%`)
}

/** 날짜만 (10/30 연도 규칙): 올해 '10.02', 다른 해 '2025.12.29' — 07 버전 저장일 · 02 하루 범위. 'YYYY-MM-DD'를 받음 (Date 파싱 없음 → 시간대 무관) */
export function fmtShortDate(ymd: string, now = new Date()): string {
  const [y, m, d] = ymd.split('-')
  return Number(y) === now.getFullYear() ? `${m}.${d}` : `${y}.${m}.${d}`
}
