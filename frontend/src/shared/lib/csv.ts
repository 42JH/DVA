// CSV 읽기 (CSV 가져오기용 — 08 CSV 기업 등록 등). 내보내기는 03 · 04 새 디자인에서 빠져 지움

/** CSV 글 → 줄 · 칸. 따옴표 칸 안의 쉼표 · 줄바꿈 · 두 번 쓴 따옴표 처리, 맨 앞 BOM · 빈 줄은 버림 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  rows.push(row)
  return rows.filter((r) => r.some((v) => v.trim() !== ''))
}
