// 줄 단위 비교 (07 버전 비교) — 두 글에서 '그대로 둔 줄'이 가장 많게(최장 공통 부분, LCS) 맞추고 나머지를 빠진 줄 · 더한 줄로
// React를 모르는 순수 함수 (실행해서 확인: lineDiff.test.ts). 프롬프트는 수십~수백 줄이라 줄 수 곱만큼 표를 만들어도 충분히 빠름
// 바뀐 묶음 안에서는 빠진 줄을 먼저, 더한 줄을 뒤에 (디자인: − 줄 아래 + 줄)

interface DiffLine {
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

export interface Part {
  kind: 'same' | 'del' | 'add'
  text: string
}

/** 같은 줄에 겹쳐 보이는 비교 — 바뀐 줄 묶음(빠진 줄 + 더한 줄)을 한 문단으로 합치고, 그 안은 글자 단위로 다시 맞춤
 * 앞뒤 같은 글자는 먼저 떼어 표를 작게 함. shortcut: 가운데 남은 글자 곱이 400만을 넘으면 통째로 빠짐 + 더함, 그런 큰 수정이 잦으면 더 빠른 비교로 교체 */
export function inlineDiff(before: string[], after: string[]) {
  const blocks: Part[][] = []
  let removed = 0
  let added = 0
  const rows = lineDiff(before, after)
  for (let i = 0; i < rows.length; ) {
    if (rows[i].kind === 'same') {
      blocks.push([{ kind: 'same', text: rows[i++].text }])
      continue
    }
    const del: string[] = []
    const add: string[] = []
    for (; i < rows.length && rows[i].kind !== 'same'; i++) {
      if (rows[i].kind === 'del') del.push(rows[i].text)
      else add.push(rows[i].text)
    }
    removed += del.length
    added += add.length
    const a = Array.from(del.join('\n'))
    const b = Array.from(add.join('\n'))
    let head = 0
    while (head < a.length && head < b.length && a[head] === b[head]) head++
    let tail = 0
    while (
      tail < a.length - head &&
      tail < b.length - head &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    )
      tail++
    const midA = a.slice(head, a.length - tail)
    const midB = b.slice(head, b.length - tail)
    const mid: Part[] =
      midA.length * midB.length > 4_000_000
        ? [
            { kind: 'del', text: midA.join('') },
            { kind: 'add', text: midB.join('') },
          ]
        : lineDiff(midA, midB).map((w) => ({ kind: w.kind, text: w.text }))
    const parts: Part[] = []
    for (const w of [
      { kind: 'same' as const, text: a.slice(0, head).join('') },
      ...mid,
      { kind: 'same' as const, text: a.slice(a.length - tail).join('') },
    ]) {
      if (!w.text) continue
      const last = parts[parts.length - 1]
      if (last && last.kind === w.kind) last.text += w.text
      else parts.push({ ...w })
    }
    blocks.push(parts)
  }
  return { blocks, removed, added }
}
