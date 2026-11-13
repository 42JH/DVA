// AI 상담가 시안 검수 (11/13, troubleshooting 41) — 시안 원본 HTML과 실제 화면을 같은 브라우저로 그려 요소별 모양 · 자리를 비교
// 1) node gen.cjs after.html                      시안 원본(HTML)
// 2) PW_CORE=<playwright-core 경로> node design.cjs   시안 23개 상태의 수치 → design.json (+ design/*.png)
// 3) mock 서버(npm run dev -- --mode mock --port 5174)를 띄우고
//    PW_CORE=<경로> node flow.cjs                  1~10번 흐름 점검(누르기 · 새로고침 · 뒤로 가기 · 화면 크기) + 화면 수치 → app.json
// 4) node compare.cjs > after.txt && python count.py after.txt
// 요소 짝(이름 · 시안 쪽 찾기 · 화면 쪽 찾기)은 specs.cjs. before.txt = 고치기 전(a343f041), after.txt = 고친 뒤
// design.json(시안) vs app.json(화면) — 다른 값만 출력. 인자: 상태 이름들(없으면 전부)
const path = require('path')
const fs = require('fs')
const D = JSON.parse(fs.readFileSync(path.join(__dirname, 'design.json'), 'utf8'))
const A = JSON.parse(fs.readFileSync(path.join(__dirname, process.env.APP_JSON || 'app.json'), 'utf8'))
const only = process.argv.slice(2)
const GEO = ['x', 'y', 'w', 'h', 'right']
const STYLE = ['fs', 'fw', 'lh', 'color', 'bg', 'bT', 'bB', 'bL', 'radius', 'pad', 'gap', 'op', 'shadow', 'deco']
const short = (v) => String(v).replace(/rgba?\(([^)]+)\)/g, (m, c) => {
  const [r, g, b, a] = c.split(',').map((x) => parseFloat(x))
  const hex = '#' + [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
  return a === undefined || a === 1 ? hex : a === 0 ? 'none' : `${hex}/${a}`
})
let total = 0
for (const [state, d] of Object.entries(D)) {
  if (only.length && !only.includes(state)) continue
  const a = A[state]
  if (!a) {
    console.log(`\n## ${state}: 화면 쪽 측정 없음`)
    continue
  }
  const lines = []
  for (const [label, dv] of Object.entries(d.probes || {})) {
    const av = (a.probes || {})[label]
    if (!dv || !av) {
      lines.push(`  ${label}: ${!dv ? '시안에서 못 찾음' : '화면에서 못 찾음'}`)
      continue
    }
    const diffs = []
    for (const k of GEO) if (Math.abs(dv[k] - av[k]) > (process.env.TOL ? Number(process.env.TOL) : 1)) diffs.push(`${k} ${dv[k]}→${av[k]}`)
    for (const k of STYLE) if (short(dv[k]) !== short(av[k])) diffs.push(`${k} ${short(dv[k])}→${short(av[k])}`)
    if (diffs.length) lines.push(`  ${label} [${dv.text.slice(0, 14)}|${av.text.slice(0, 14)}]: ${diffs.join(', ')}`)
  }
  for (const [label, dn] of Object.entries(d.counts || {})) {
    const an = (a.counts || {})[label]
    if (dn !== an) lines.push(`  ${label}: 시안 ${dn}개 → 화면 ${an}개`)
  }
  total += lines.length
  console.log(`\n## ${state} (시안 → 화면) 다른 곳 ${lines.length}`)
  for (const l of lines) console.log(l)
}
console.log(`\n다른 항목 합계 ${total}`)
