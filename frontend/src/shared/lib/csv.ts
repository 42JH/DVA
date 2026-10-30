// CSV 내보내기 (04 통화 내역 · 03 주문 내역 공통)
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
