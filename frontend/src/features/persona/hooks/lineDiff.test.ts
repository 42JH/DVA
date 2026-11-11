// 실행: npx tsx src/features/persona/hooks/lineDiff.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { inlineDiff, lineDiff } from './lineDiff'

const kinds = (a: string[], b: string[]) =>
  lineDiff(a, b)
    .map((d) => (d.kind === 'same' ? ' ' : d.kind === 'del' ? '-' : '+') + d.text)
    .join('|')

assert.equal(kinds(['a', 'b'], ['a', 'b']), ' a| b') // 같으면 전부 그대로
assert.equal(kinds([], ['a']), '+a')
assert.equal(kinds(['a'], []), '-a')
assert.equal(kinds(['a', 'x', 'c'], ['a', 'y', 'c']), ' a|-x|+y| c') // 바뀐 줄 = 빠진 줄 먼저, 더한 줄 뒤
assert.equal(kinds(['a', 'c'], ['a', 'b', 'c']), ' a|+b| c') // 끼워 넣기

// 디자인 07 버전 비교 예시: v6 → v7 = 빠진 줄 2 · 더한 줄 3, 줄 번호는 양쪽 따로
const v6 = [
  '# 역할',
  '복창 항목마다',
  '',
  '# 되묻기',
  '잘 안 들린 것만',
  '확인된 것도 한 번 더',
  '',
  '# 주소',
]
const v7 = [
  '# 역할',
  '복창 한 번에',
  '',
  '# 되묻기',
  '잘 안 들린 것만',
  '확인된 것은 안 물음',
  '전화번호 끊어 복창',
  '',
  '# 주소',
]
const d = lineDiff(v6, v7)
assert.equal(d.filter((x) => x.kind === 'del').length, 2)
assert.equal(d.filter((x) => x.kind === 'add').length, 3)
const last = d[d.length - 1]
assert.deepEqual([last.from, last.to], [8, 9]) // 마지막 줄: v6 8번 = v7 9번 (한 줄 늘어서)
assert.deepEqual(
  d.filter((x) => x.kind !== 'same').map((x) => [x.kind, x.from, x.to]),
  [
    ['del', 2, null],
    ['add', null, 2],
    ['del', 6, null],
    ['add', null, 6],
    ['add', null, 7],
  ],
)

console.log('lineDiff.test ok')

// 글자 단위: ㅇㅇㅇㅇ → ㅇㅇㄴㄴㅇㅇ 는 ㄴㄴ만 더함
assert.deepEqual(inlineDiff(['ㅇㅇㅇㅇ'], ['ㅇㅇㄴㄴㅇㅇ']).blocks, [
  [
    { kind: 'same', text: 'ㅇㅇ' },
    { kind: 'add', text: 'ㄴㄴ' },
    { kind: 'same', text: 'ㅇㅇ' },
  ],
])
