// 화면 문구 점검 — 주석이 아닌 글(문자열 · 템플릿 · JSX 글자)에서 가운뎃점 나열(' · ') · 줄표 설명(' — ') · 화살표(→)를 찾음
// 주석은 AST에 없어 저절로 빠짐. 가짜 서버 · 테스트는 빼고 봄. 실행: node copyscan.cjs <frontend 폴더>
const path = require('path')
const fs = require('fs')
const root = path.resolve(process.argv[2])
const ts = require(path.join(root, 'node_modules/typescript'))
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
const MARK = / · | — |→|←/
const hits = []
for (const f of files) {
  const sf = ts.createSourceFile(f, fs.readFileSync(f, 'utf8'), ts.ScriptTarget.Latest, true, f.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const add = (n, text) => {
    if (!MARK.test(text)) return
    // className 같은 속성 값 · import 경로는 문구가 아님
    const p = n.parent
    if (p && ts.isJsxAttribute(p) && /^(className|class|d|viewBox|key|id|to|href)$/.test(p.name.getText(sf))) return
    hits.push({ file: path.relative(path.join(root, 'src'), f).replace(/\\/g, '/'), line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text: text.replace(/\s+/g, ' ').trim().slice(0, 150) })
  }
  const visit = (n) => {
    if (ts.isStringLiteralLike(n)) add(n, n.text)
    else if (ts.isTemplateExpression(n)) add(n, n.getText(sf).slice(1, -1))
    else if (ts.isJsxText(n)) add(n, n.text)
    if (!ts.isTemplateExpression(n)) ts.forEachChild(n, visit)
    else n.templateSpans.forEach((s) => visit(s.expression))
  }
  visit(sf)
}
for (const h of hits) console.log(`${h.file}:${h.line}  ${h.text}`)
console.log(`문구 ${hits.length}곳`)
