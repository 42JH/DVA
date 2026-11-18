import assert from 'node:assert/strict'
import { test } from 'node:test'
import { oldestPage, pageGroup } from './paging'

test('쪽 번호는 10쪽씩 묶음', () => {
  assert.deepEqual(pageGroup(1, 3), [1, 2, 3])
  assert.deepEqual(pageGroup(1, 36), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(pageGroup(10, 36), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(pageGroup(11, 36), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  assert.deepEqual(pageGroup(36, 36), [31, 32, 33, 34, 35, 36])
})

test('오래된 순 쪽은 최신순 목록의 뒤쪽을 잘라 뒤집음', async () => {
  const all = [7, 6, 5, 4, 3, 2, 1] // 서버 최신순
  const get = async (limit: number, offset: number) => ({
    data: all.slice(offset, offset + limit),
    hasNext: false,
    total_count: all.length,
  })
  assert.deepEqual((await oldestPage(7, 1, 3, get)).data, [1, 2, 3])
  assert.deepEqual((await oldestPage(7, 2, 3, get)).data, [4, 5, 6])
  assert.deepEqual((await oldestPage(7, 3, 3, get)).data, [7])
  assert.deepEqual((await oldestPage(7, 4, 3, get)).data, [])
  assert.deepEqual((await oldestPage(0, 1, 3, get)).data, [])
})
