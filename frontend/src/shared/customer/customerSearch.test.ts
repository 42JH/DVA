import assert from 'node:assert/strict'
import { test } from 'node:test'
import { customerSearch } from './customerSearch'

test('고객 검색 조건 — 번호 4~11자리 부분 · 이름 · 짧은 번호', () => {
  assert.deepEqual(customerSearch('010-1234-5678'), { phoneNumber: '01012345678' })
  assert.deepEqual(customerSearch('5678'), { phoneNumber: '5678' }) // 뒷자리로도
  assert.deepEqual(customerSearch(' 김지 '), { q: '김지' })
  assert.deepEqual(customerSearch('김1'), { q: '김1' }) // 글자가 섞이면 이름
  assert.equal(customerSearch('010'), null) // 3자리 이하는 거의 모든 고객이 걸림
  assert.equal(customerSearch('010123456789'), null) // 12자리는 서버가 400
  assert.equal(customerSearch('  '), null)
})
