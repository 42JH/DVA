// 날짜 · 번호 표시 규칙 (와이어프레임 10/23 결정 #7)
// 목록의 활동 시각 = 'MM.DD HH:MM' · 오래 남는 날짜(등록일 · 가입 신청일 · 버전 생성일) = 'YYYY.MM.DD'
// 상세 화면의 시각 = 'MM.DD (요일) HH:MM' (06 · 05 상세) — 서버는 ISO 8601(타임존 포함), 화면은 Asia/Seoul
// 10/30 연도 규칙 (모든 페이지): 올해면 연도 생략, 다른 해(작년 포함)면 'YYYY.MM.DD' → 새 목록은 fmtListTime

const two = (n: number) => String(n).padStart(2, '0')
const DAY = ['일', '월', '화', '수', '목', '금', '토']

/** 상세 화면 시각 (10/30 연도 규칙): 올해 '10.20 (화) 13:12', 다른 해 '2025.12.29 (월) 13:12'. seconds면 '13:12:08' (06 통화 시작 시각) */
export function fmtDetailTime(iso: string, { seconds = false, now = new Date() } = {}): string {
  const d = new Date(iso)
  const date =
    d.getFullYear() === now.getFullYear()
      ? `${two(d.getMonth() + 1)}.${two(d.getDate())}`
      : fmtDate(iso)
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

/** 초 → '3분 40초' (04 통화 시간) */
export function fmtDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)}분 ${two(seconds % 60)}초`
}

/** 초 → '03:40' (06 통화 안 시각 · 재생 바) */
export function fmtClock(seconds: number): string {
  return `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`
}

/** 숫자 문자열 전화번호 → 010-1234-5678 (명세서: 전달 · 저장은 숫자만) */
export function fmtPhone(digits: string): string {
  const d = digits.replace(/\D/g, '')
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`
  return digits
}
