// 안 쓰는 코드 재검 — 이름 비교가 아니라 타입스크립트의 참조 추적(findReferences)으로 셈. 저장소는 읽기만 함
//  1) export: 다른 앱 파일(테스트 · mock 제외)에서 쓰는가, 자기 파일 안에서 쓰는가, 테스트 · mock만 쓰는가
//  2) 타입 칸(interface · type의 속성): 앱 코드에서 한 번이라도 읽는가 / 값만 넣는가 / 선언만 있는가
//  3) 훅(use*)이 돌려주는 값(안쪽 객체 포함): 앱 코드에서 읽는가
// 실행: node tsrefs.cjs <frontend 폴더> > out.json
const path = require('path')
const fs = require('fs')
const root = path.resolve(process.argv[2])
const ts = require(path.join(root, 'node_modules/typescript'))

const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.app.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')) },
})
const files = cfg.fileNames
const host = {
  getScriptFileNames: () => files,
  getScriptVersion: () => '1',
  getScriptSnapshot: (f) => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8')) : undefined),
  getCurrentDirectory: () => root,
  getCompilationSettings: () => cfg.options,
  getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
  fileExists: ts.sys.fileExists,
  readFile: ts.sys.readFile,
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
}
const ls = ts.createLanguageService(host, ts.createDocumentRegistry())
const program = ls.getProgram()
const checker = program.getTypeChecker()

const norm = (f) => f.replace(/\\/g, '/')
const rel = (f) => norm(f).split('/frontend/')[1] ?? norm(f)
const kindOf = (f) => (/\.test\.ts$/.test(f) ? 'test' : /\/src\/mocks\//.test(norm(f)) ? 'mock' : /\/src\//.test(norm(f)) ? 'app' : 'other')
const srcFiles = program.getSourceFiles().filter((s) => /\/frontend\/src\//.test(norm(s.fileName)) && !s.isDeclarationFile)

const nodeAt = (sf, pos) => {
  let found = sf
  const visit = (n) => {
    if (pos >= n.getStart(sf) && pos < n.getEnd()) {
      found = n
      ts.forEachChild(n, visit)
    }
  }
  visit(sf)
  return found
}
/** 참조 한 곳이 속성을 '읽는' 자리인가 — obj.a · obj['a'] · const { a } = obj · T['a']만 읽기로 셈
 *  (객체에 값 넣기 · JSX로 넘기기 · 선언은 읽기가 아님. 그냥 변수로 쓰인 이름은 속성이 아니라 지역 변수) */
const isRead = (n) => {
  const p = n.parent
  if (!p) return false
  if (ts.isPropertyAccessExpression(p)) return p.name === n
  if (ts.isBindingElement(p)) return p.propertyName === n || (!p.propertyName && p.name === n)
  if (ts.isElementAccessExpression(p)) return p.argumentExpression === n
  if (ts.isQualifiedName(p)) return p.right === n
  if (ts.isLiteralTypeNode(p)) return !!p.parent && ts.isIndexedAccessTypeNode(p.parent)
  if (ts.isJsxAttribute(p)) return false
  return false
}
const refsOf = (sf, name) => {
  const out = { app: 0, own: 0, test: 0, mock: 0, reads: { app: 0, test: 0, mock: 0 }, writes: 0 }
  const found = ls.findReferences(sf.fileName, name.getStart(sf)) ?? []
  for (const sym of found)
    for (const r of sym.references) {
      const rsf = program.getSourceFile(r.fileName)
      if (!rsf) continue
      const n = nodeAt(rsf, r.textSpan.start)
      if (n === name) continue
      const k = kindOf(r.fileName)
      if (k === 'other') continue
      // export { x } · import { x } 줄은 쓰는 것이 아님 (가져와서 안 쓰면 컴파일 오류라, 가져온 파일의 실제 사용이 따로 잡힘)
      if (n.parent && (ts.isImportSpecifier(n.parent) || ts.isExportSpecifier(n.parent) || ts.isImportClause(n.parent))) continue
      if (norm(r.fileName) === norm(sf.fileName)) out.own++
      else out[k]++
      if (isRead(n)) out.reads[k]++
      else out.writes++
    }
  return out
}
const hasExport = (n) => !!(ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export)

const result = { exports: [], fields: [], vm: [] }
const seen = new Set()
for (const sf of srcFiles) {
  const fk = kindOf(sf.fileName)
  if (fk !== 'app') continue
  // 1) export
  for (const st of sf.statements) {
    const names = []
    if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name && hasExport(st)) names.push([st.name, ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) ? 'type' : 'value'])
    if (ts.isVariableStatement(st) && hasExport(st)) for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) names.push([d.name, 'value'])
    for (const [name, what] of names) {
      const r = refsOf(sf, name)
      if (r.app === 0) result.exports.push({ file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(name.getStart(sf)).line + 1, name: name.text, what, own: r.own, test: r.test, mock: r.mock })
    }
  }
  // 2) 타입 칸 · 3) 훅 반환값
  const visit = (n, hook) => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) && /^use[A-Z]/.test(n.name.text)) hook = n.name.text
    if (ts.isPropertySignature(n) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))) {
      const sym = checker.getSymbolAtLocation(n.name)
      const id = sym ? ts.getSymbolId(sym) : null
      if (id && !seen.has(id)) {
        seen.add(id)
        const r = refsOf(sf, n.name)
        if (r.reads.app === 0) {
          let owner = n.parent
          while (owner && !ts.isInterfaceDeclaration(owner) && !ts.isTypeAliasDeclaration(owner) && !ts.isFunctionLike(owner) && !ts.isVariableDeclaration(owner)) owner = owner.parent
          result.fields.push({ file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(n.name.getStart(sf)).line + 1, owner: owner?.name?.getText?.(sf) ?? '(이름 없는 타입)', name: n.name.text, writes: r.writes, testReads: r.reads.test, mockReads: r.reads.mock })
        }
      }
    }
    if (hook && ts.isReturnStatement(n) && n.expression) collect(n.expression, hook)
    ts.forEachChild(n, (c) => visit(c, hook))
  }
  const collect = (expr, hook) => {
    const walk = (n) => {
      if (ts.isObjectLiteralExpression(n))
        for (const p of n.properties) {
          if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)) {
            const sym = checker.getSymbolAtLocation(p.name)
            // 라이브러리 · 선언된 타입의 칸이면(문맥 타입) 건너뜀 — 여기서는 훅이 새로 만든 값만
            const decls = sym?.declarations ?? []
            if (decls.some((d) => d.getSourceFile().isDeclarationFile || /node_modules/.test(d.getSourceFile().fileName))) continue
            const key = `${sf.fileName}:${p.name.getStart(sf)}`
            if (seen.has(key)) continue
            seen.add(key)
            const r = refsOf(sf, p.name)
            if (r.reads.app === 0) result.vm.push({ file: rel(sf.fileName), line: sf.getLineAndCharacterOfPosition(p.name.getStart(sf)).line + 1, hook, name: p.name.text, testReads: r.reads.test })
          }
        }
      ts.forEachChild(n, walk)
    }
    walk(expr)
  }
  visit(sf, null)
}
process.stdout.write(JSON.stringify(result))
