import assert from 'node:assert/strict'
import { test } from 'node:test'
import { customerSearch } from './customerSearch'

test('고객 검색 조건 — 번호 11자리 · 이름 · 번호 일부', () => {
  assert.deepEqual(customerSearch('010-1234-5678'), { phoneNumber: '01012345678' })
  assert.deepEqual(customerSearch(' 김지 '), { q: '김지' })
  assert.equal(customerSearch('0101234'), null) // 서버가 번호 일부를 못 찾음
  assert.equal(customerSearch('  '), null)
})
