// CSV 내보내기 (04 통화 내역 · 03 주문 내역 공통) · 읽기 (03 CSV로 추가)
// 엑셀에서 한글이 깨지지 않게 맨 앞에 BOM, 쉼표 · 따옴표 · 줄바꿈이 든 칸은 따옴표로 감쌈 (따옴표는 두 번)

export function toCsv(header: string[], rows: (string | number)[][]): string {
  const cell = (v: string | number) => {
    const s = String(v)
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
  }
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')
}

/** 브라우저에서 파일로 저장 (서버 없이) */
export function downloadCsv(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** CSV 글 → 줄 · 칸 (toCsv의 반대). 따옴표 칸 안의 쉼표 · 줄바꿈 · 두 번 쓴 따옴표 처리, 맨 앞 BOM · 빈 줄은 버림 */
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
