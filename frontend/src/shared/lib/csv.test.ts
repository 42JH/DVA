// 실행: npx tsx src/shared/lib/csv.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { toCsv } from './csv'

assert.equal(toCsv(['이름', '시간'], [['강도윤', 220]]), '이름,시간\r\n강도윤,220')
// 쉼표 · 따옴표 · 줄바꿈이 든 칸은 따옴표로 감싸고, 안의 따옴표는 두 번
assert.equal(toCsv(['사유'], [['a,b']]), '사유\r\n"a,b"')
assert.equal(
  toCsv(['사유'], [['\'중간 박스\'를 "못" 들음']]),
  '사유\r\n"\'중간 박스\'를 ""못"" 들음"',
)
assert.equal(toCsv(['사유'], [['한 줄\n두 줄']]), '사유\r\n"한 줄\n두 줄"')

console.log('csv.test ok')
