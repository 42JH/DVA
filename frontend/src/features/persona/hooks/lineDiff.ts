// 줄 단위 비교 (07 버전 비교) — 두 글에서 '그대로 둔 줄'이 가장 많게(최장 공통 부분, LCS) 맞추고 나머지를 빠진 줄 · 더한 줄로
// React를 모르는 순수 함수 (실행해서 확인: lineDiff.test.ts). 프롬프트는 수십~수백 줄이라 줄 수 곱만큼 표를 만들어도 충분히 빠름
// 바뀐 묶음 안에서는 빠진 줄을 먼저, 더한 줄을 뒤에 (디자인: − 줄 아래 + 줄)

export interface DiffLine {
  kind: 'same' | 'del' | 'add'
  text: string
  from: number | null // 앞 버전 줄 번호 (더한 줄은 없음)
  to: number | null // 뒤 버전 줄 번호 (빠진 줄은 없음)
}

export function lineDiff(before: string[], after: string[]): DiffLine[] {
  const n = before.length
  const m = after.length
  // lcs[i][j] = before[i..] 와 after[j..] 의 공통 줄 수 (뒤에서부터 채움)
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      out.push({ kind: 'same', text: before[i], from: ++i, to: ++j })
    } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ kind: 'del', text: before[i], from: ++i, to: null })
    } else {
      out.push({ kind: 'add', text: after[j], from: null, to: ++j })
    }
  }
  return out
}
