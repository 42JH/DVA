// 날짜 형식 하나로 — 날짜+시각 '2026-10-25 11:11', 날짜만 '2026-10-25' (표 · 상세 · 창 모두 같음, 24시간제)
// 통화 길이('2분 48초') · 녹취 위치('00:31')는 날짜가 아니라 따로
const two = (n: number) => String(n).padStart(2, '0')

const parse = (iso: string | null | undefined) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

/** '2026-10-25' — 없으면 '' */
export function date(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}` : ''
}

/** '2026-10-25 11:11' — 없으면 '' */
export function dateTime(iso: string | null | undefined): string {
  const d = parse(iso)
  return d ? `${date(iso)} ${two(d.getHours())}:${two(d.getMinutes())}` : ''
}
