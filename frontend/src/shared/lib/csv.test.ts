// 실행: npx tsx src/shared/lib/csv.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { parseCsv, toCsv } from './csv'

assert.equal(toCsv(['이름', '시간'], [['강도윤', 220]]), '이름,시간\r\n강도윤,220')
// 쉼표 · 따옴표 · 줄바꿈이 든 칸은 따옴표로 감싸고, 안의 따옴표는 두 번
assert.equal(toCsv(['사유'], [['a,b']]), '사유\r\n"a,b"')
assert.equal(
  toCsv(['사유'], [['\'중간 박스\'를 "못" 들음']]),
  '사유\r\n"\'중간 박스\'를 ""못"" 들음"',
)
assert.equal(toCsv(['사유'], [['한 줄\n두 줄']]), '사유\r\n"한 줄\n두 줄"')
// 수식으로 실행될 글은 앞에 ' (숫자 -3은 그대로)
assert.equal(toCsv(['a', 'b'], [['=1+1', -3]]), "a,b\r\n'=1+1,-3")
assert.equal(toCsv(['a'], [['@x,y']]), 'a\r\n"\'@x,y"')

// parseCsv = toCsv의 반대 (따옴표 · 쉼표 · 줄바꿈 · BOM · CRLF · 빈 줄)
const table = [
  ['이름', '사유'],
  ['강도윤', 'a,b'],
  ['박지호', '\'중간 박스\'를 "못" 들음'],
  ['정하은', '한 줄\n두 줄'],
]
assert.deepEqual(parseCsv(toCsv(table[0], table.slice(1))), table)
assert.deepEqual(parseCsv('\uFEFF이름,번호\r\n강도윤,010\r\n\r\n'), [
  ['이름', '번호'],
  ['강도윤', '010'],
])
assert.deepEqual(parseCsv('a,,c\n'), [['a', '', 'c']]) // 빈 칸은 빈 글자

console.log('csv.test ok')
