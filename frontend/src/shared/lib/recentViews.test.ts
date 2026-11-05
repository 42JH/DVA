// 실행: npx tsx --tsconfig tsconfig.app.json src/shared/lib/recentViews.test.ts  (프레임워크 없이 assert만, node엔 localStorage가 없어 메모리로만)
import assert from 'node:assert/strict'
import { clearRecentViews, forgetView, recentViewsNow, rememberView } from './recentViews'

const ids = (kind: string) =>
  recentViewsNow()
    .filter((v) => v.kind === kind)
    .map((v) => v.id)

// 탭(종류)마다 최대 7개 · 최근이 위
for (let i = 1; i <= 9; i++) rememberView({ kind: 'faq', id: i, label: `FAQ ${i}` })
assert.deepEqual(ids('faq'), [9, 8, 7, 6, 5, 4, 3])

// 다른 탭은 따로 셈
rememberView({ kind: 'order', id: 10525, label: '김민준', to: '노하윤' })
assert.deepEqual(ids('order'), [10525])
assert.equal(ids('faq').length, 7)

// 다시 열면 맨 위로 (같은 항목은 한 번만)
rememberView({ kind: 'faq', id: 5, label: 'FAQ 5' })
assert.deepEqual(ids('faq'), [5, 9, 8, 7, 6, 4, 3])

// 지워진 항목 빼기 · 한 탭만 전체 삭제
forgetView('faq', 9)
assert.deepEqual(ids('faq'), [5, 8, 7, 6, 4, 3])
clearRecentViews('faq')
assert.deepEqual(ids('faq'), [])
assert.deepEqual(ids('order'), [10525])

// 세션 끝 = 전부
clearRecentViews()
assert.equal(recentViewsNow().length, 0)

console.log('recentViews.test.ts OK')
