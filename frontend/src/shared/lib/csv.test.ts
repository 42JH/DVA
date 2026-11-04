// 실행: npx tsx src/shared/lib/csv.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { parseCsv } from './csv'

// 따옴표 칸 안의 쉼표 · 두 번 쓴 따옴표 · 줄바꿈
assert.deepEqual(
  parseCsv(
    '이름,사유\r\n강도윤,"a,b"\r\n박지호,"\'중간 박스\'를 ""못"" 들음"\r\n정하은,"한 줄\n두 줄"',
  ),
  [
    ['이름', '사유'],
    ['강도윤', 'a,b'],
    ['박지호', '\'중간 박스\'를 "못" 들음'],
    ['정하은', '한 줄\n두 줄'],
  ],
)
// BOM · CRLF · 빈 줄
assert.deepEqual(parseCsv('﻿이름,번호\r\n강도윤,010\r\n\r\n'), [
  ['이름', '번호'],
  ['강도윤', '010'],
])
assert.deepEqual(parseCsv('a,,c\n'), [['a', '', 'c']]) // 빈 칸은 빈 글자

console.log('csv.test ok')
