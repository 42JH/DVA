// 날짜 · 번호 표시 규칙 (와이어프레임 10/23 결정 #7)
// 목록의 활동 시각 = 'MM.DD HH:MM' · 오래 남는 날짜(등록일 · 가입 신청일 · 버전 생성일) = 'YYYY.MM.DD'
// 상세 화면의 시각 = 'MM.DD (요일) HH:MM' (06 · 05 상세) — 서버는 ISO 8601(타임존 포함), 화면은 Asia/Seoul

const two = (n: number) => String(n).padStart(2, '0')
const DAY = ['일', '월', '화', '수', '목', '금', '토']

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

/** '10.20 (화)' (01 홈 '오늘' 기준일) */
export function fmtDateDay(d: Date): string {
  return `${two(d.getMonth() + 1)}.${two(d.getDate())} (${DAY[d.getDay()]})`
}

/** 'HH:MM' (오늘 안의 시각) */
export function fmtTime(iso: string): string {
  const d = new Date(iso)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
