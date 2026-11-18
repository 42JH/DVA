// 안 읽는 값 재검 (2차) — '읽는 자리'에서 거꾸로: 앱 코드의 모든 속성 읽기(obj.a · 구조 분해 · obj['a'] · T['a'])가
// 가리키는 선언을 모은 뒤, 한 번도 안 읽힌 선언을 찾음. 펼침(...)·합집합·Pick 같은 타입을 거쳐도 원래 선언까지 따라감(getRootSymbols)
// 통째로 넘기는 자리(JSX 펼침 · Object.keys/values/entries · JSON.stringify · 변수 키 접근 · 나머지 구조 분해)는 그 객체의 칸을 모두 읽은 것으로 침
// 대상: (1) interface · type의 속성 (2) 훅(use*)이 돌려주는 객체의 속성(안쪽 객체 포함). 저장소는 읽기만 함
// 실행: node tsreads.cjs <frontend 폴더> > reads.json
const path = require('path')
const fs = require('fs')
const root = path.resolve(process.argv[2])
const ts = require(path.join(root, 'node_modules/typescript'))
const cfg = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.app.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')) },
})
const program = ts.createProgram(cfg.fileNames, cfg.options)
const checker = program.getTypeChecker()
const norm = (f) => f.replace(/\\/g, '/')
const rel = (f) => norm(f).split('/frontend/')[1] ?? norm(f)
const kindOf = (f) => (/\.test\.ts$/.test(f) ? 'test' : /\/src\/mocks\//.test(norm(f)) ? 'mock' : /\/frontend\/src\//.test(norm(f)) ? 'app' : 'other')
const sources = program.getSourceFiles().filter((s) => !s.isDeclarationFile && /\/frontend\/src\//.test(norm(s.fileName)))

const read = { app: new Set(), mock: new Set() }
const addSym = (sym, where) => {
  if (!sym) return
  const roots = checker.getRootSymbols(sym)
  for (const r of roots.length ? roots : [sym]) for (const d of r.declarations ?? []) read[where].add(d)
  for (const d of sym.declarations ?? []) read[where].add(d)
}
const addAllProps = (type, where) => {
  if (!type) return
  const types = type.isUnionOrIntersection() ? type.types : [type]
  for (const t of types) for (const p of checker.getApparentType(t).getProperties()) addSym(p, where)
}
const WHOLE = new Set(['keys', 'values', 'entries', 'stringify', 'assign', 'fromEntries'])
/** 통째로 넘긴 값(JSX 속성 · 함수 인자 · as/satisfies · 타입을 적은 변수) — 받는 쪽이 다른 타입 이름으로 읽을 수 있으므로
 *  그 값의 칸을 안쪽 객체 · 배열 원소까지(3단) 모두 읽은 것으로 침. 앱 코드에 선언된 칸만 따라감(DOM · 라이브러리 타입은 건너뜀) */
const inApp = (sym) => (sym.declarations ?? []).some((d) => !d.getSourceFile().isDeclarationFile && /\/frontend\/src\//.test(norm(d.getSourceFile().fileName)))
const markDeep = (type, where, depth, seenTypes) => {
  if (!type || depth > 3 || seenTypes.has(type)) return
  seenTypes.add(type)
  if (type.isUnionOrIntersection()) return type.types.forEach((t) => markDeep(t, where, depth, seenTypes))
  if (checker.isArrayType(type) || checker.isTupleType(type)) return (checker.getTypeArguments(type) ?? []).forEach((t) => markDeep(t, where, depth, seenTypes))
  if (!(type.flags & ts.TypeFlags.Object)) return
  for (const p of type.getProperties()) {
    if (!inApp(p)) continue
    addSym(p, where)
    const d = p.valueDeclaration ?? p.declarations?.[0]
    if (d) markDeep(checker.getTypeOfSymbolAtLocation(p, d), where, depth + 1, seenTypes)
  }
}
/** 넘겨받는 쪽 타입이 넘기는 값과 같은 타입이면(예: Provider value={s} — 둘 다 Shell) 경계가 아님 → 받는 쪽의 읽기가 그대로 잡히므로 치지 않음 */
const sameType = (a, b) => {
  if (!a || !b) return false
  const x = checker.getNonNullableType(a)
  const y = checker.getNonNullableType(b)
  if (x === y) return true
  if (x.aliasSymbol && x.aliasSymbol === y.aliasSymbol) return true
  const sx = x.symbol
  return !!sx && sx === y.symbol && (sx.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) !== 0
}
const handOver = (expr, where, target) => {
  if (!expr) return
  const src = checker.getTypeAtLocation(expr)
  const ctx = target ?? checker.getContextualType(expr)
  if (ctx && sameType(src, ctx)) return
  markDeep(src, where, 0, new Set())
}
for (const sf of sources) {
  const where = kindOf(sf.fileName) === 'mock' ? 'mock' : 'app'
  const visit = (n) => {
    if (ts.isPropertyAccessExpression(n)) addSym(checker.getSymbolAtLocation(n.name), where)
    else if (ts.isElementAccessExpression(n)) {
      const a = n.argumentExpression
      if (a && (ts.isStringLiteralLike(a) || ts.isNumericLiteral(a))) addSym(checker.getSymbolAtLocation(a), where)
      else addAllProps(checker.getTypeAtLocation(n.expression), where)
    } else if (ts.isObjectBindingPattern(n)) {
      const type = checker.getTypeAtLocation(n)
      for (const e of n.elements) {
        if (e.dotDotDotToken) addAllProps(type, where)
        else {
          const key = e.propertyName ?? e.name
          if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) {
            const types = type.isUnionOrIntersection() ? type.types : [type]
            for (const t of types) addSym(checker.getApparentType(t).getProperty(key.text), where)
          }
        }
      }
    } else if (ts.isJsxSpreadAttribute(n)) handOver(n.expression, where)
    else if (ts.isJsxAttribute(n) && n.initializer && ts.isJsxExpression(n.initializer)) handOver(n.initializer.expression, where)
    else if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) handOver(n.expression, where, checker.getTypeFromTypeNode(n.type))
    else if (ts.isVariableDeclaration(n) && n.type && n.initializer) handOver(n.initializer, where, checker.getTypeFromTypeNode(n.type))
    else if (ts.isNewExpression(n)) (n.arguments ?? []).forEach((a) => handOver(a, where))
    else if (ts.isCallExpression(n)) {
      // 함수에 넘긴 값 — 화면 틀(Provider value) · 도우미 함수가 다른 타입으로 받아 읽음. 훅 호출(useX(...))의 인자는 넘기는 쪽이라 같이 침
      for (const arg of n.arguments) handOver(arg, where)
    } else if (ts.isIndexedAccessTypeNode(n) && ts.isLiteralTypeNode(n.indexType) && ts.isStringLiteral(n.indexType.literal)) {
      addSym(checker.getTypeFromTypeNode(n.objectType).getProperty(n.indexType.literal.text), where)
    } else if (ts.isForInStatement(n)) addAllProps(checker.getTypeAtLocation(n.expression), where)
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

const isLib = (sym) => (sym?.declarations ?? []).some((d) => d.getSourceFile().isDeclarationFile || /node_modules/.test(d.getSourceFile().fileName))
const wasRead = (decl, sym, where) => {
  if (read[where].has(decl)) return true
  const roots = sym ? checker.getRootSymbols(sym) : []
  return [...roots, ...(sym ? [sym] : [])].some((s) => (s.declarations ?? []).some((d) => read[where].has(d)))
}
const out = { fields: [], vm: [] }
for (const sf of sources) {
  if (kindOf(sf.fileName) !== 'app') continue
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const visit = (n, hook) => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name) && /^use[A-Z]/.test(n.name.text)) hook = n.name.text
    if (ts.isPropertySignature(n) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteralLike(n.name))) {
      const sym = checker.getSymbolAtLocation(n.name)
      if (!wasRead(n, sym, 'app')) {
        let owner = n.parent
        while (owner && !ts.isInterfaceDeclaration(owner) && !ts.isTypeAliasDeclaration(owner) && !ts.isFunctionLike(owner) && !ts.isVariableDeclaration(owner)) owner = owner.parent
        out.fields.push({ file: rel(sf.fileName), line: line(n), owner: owner?.name?.getText?.(sf) ?? '(이름 없는 타입)', name: n.name.text, mockReads: wasRead(n, sym, 'mock') })
      }
    }
    if (hook && ts.isReturnStatement(n) && n.expression) collect(n.expression, hook)
    ts.forEachChild(n, (c) => visit(c, hook))
  }
  const done = new Set()
  const collect = (expr, hook) => {
    const walk = (n) => {
      if (ts.isObjectLiteralExpression(n)) {
        const ctx = checker.getContextualType(n)
        for (const p of n.properties) {
          if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) || !ts.isIdentifier(p.name) || done.has(p)) continue
          done.add(p)
          const ctxProp = ctx?.getProperty(p.name.text)
          if (isLib(ctxProp)) continue // 라이브러리에 넘기는 옵션 (queryKey · onSuccess …)
          const own = checker.getSymbolAtLocation(p.name)
          const propSym = checker.getTypeAtLocation(n).getProperty(p.name.text)
          if (wasRead(p, propSym, 'app') || wasRead(p, own, 'app') || (ctxProp && wasRead(p, ctxProp, 'app'))) continue
          out.vm.push({ file: rel(sf.fileName), line: line(p), hook, name: p.name.text })
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(expr)
  }
  visit(sf, null)
}
process.stdout.write(JSON.stringify(out))
