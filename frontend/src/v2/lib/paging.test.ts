import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageGroup } from './paging'

test('쪽 번호는 10쪽씩 묶음', () => {
  assert.deepEqual(pageGroup(1, 3), [1, 2, 3])
  assert.deepEqual(pageGroup(1, 36), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(pageGroup(10, 36), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual(pageGroup(11, 36), [11, 12, 13, 14, 15, 16, 17, 18, 19, 20])
  assert.deepEqual(pageGroup(36, 36), [31, 32, 33, 34, 35, 36])
})
