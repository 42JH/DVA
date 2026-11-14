// 겹친 삼항 연산자 목록 — 맨 바깥 삼항마다 조건 수(else로 이어진 수)와 '참일 때' 안에 또 삼항이 있는지
// else로만 이어진 2단(a ? x : b ? y : z)은 else-if와 같아 읽기 쉽고, 3단 이상 · 참 쪽에 겹친 것이 문제
// 실행: node ternaries.cjs <frontend 폴더> [자세히]
const path = require('path')
const fs = require('fs')
const root = path.resolve(process.argv[2])
const ts = require(path.join(root, 'node_modules/typescript'))
const full = !!process.argv[3]
const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'mocks') walk(p)
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(p)
  }
}
walk(path.join(root, 'src'))
const out = []
for (const f of files) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true)
  const strip = (n) => {
    while (ts.isParenthesizedExpression(n)) n = n.expression
    return n
  }
  const has = (n) => {
    let hit = false
    const v = (x) => {
      if (ts.isConditionalExpression(x)) hit = true
      else if (!ts.isFunctionLike(x)) ts.forEachChild(x, v)
    }
    v(n)
    return hit
  }
  const visit = (n, inside) => {
    if (ts.isConditionalExpression(n) && !inside) {
      let chain = 1
      let inTrue = has(n.whenTrue)
      let e = strip(n.whenFalse)
      while (ts.isConditionalExpression(e)) {
        chain++
        if (has(e.whenTrue)) inTrue = true
        e = strip(e.whenFalse)
      }
      if (chain > 1 || inTrue)
        out.push({ file: path.relative(path.join(root, 'src'), f).replace(/\\/g, '/'), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, chain, inTrue, jsx: /<[A-Za-z]/.test(n.getText(sf)) })
      ts.forEachChild(n, (c) => visit(c, true))
      return
    }
    ts.forEachChild(n, (c) => visit(c, ts.isFunctionLike(n) ? false : inside))
  }
  visit(sf, false)
}
const deep = out.filter((o) => o.chain >= 3 || o.inTrue)
console.log(`겹친 삼항 ${out.length}묶음 — else로 2단 ${out.filter((o) => o.chain === 2 && !o.inTrue).length} · 3단 이상 ${out.filter((o) => o.chain >= 3).length} · 참 쪽에 겹침 ${out.filter((o) => o.inTrue).length}`)
for (const o of full ? out : deep)
  console.log(`  ${o.chain}단${o.inTrue ? ' +참 쪽' : ''}${o.jsx ? ' (JSX)' : ''}  ${o.file}:${o.line}`)
