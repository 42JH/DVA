// 실행: npx tsx --tsconfig tsconfig.app.json src/shared/search/searchApi.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import { memberMatches } from '@/shared/lib/search'
import type { MemberHit } from './searchApi'

const m: MemberHit = {
  organizationSeq: 1,
  organizationName: '디버물류',
  membershipSeq: 101,
  departmentName: '물류센터',
  addressData: { name: '김하준', phoneNumber: '01012340000' },
}

// 사원 이름 · 전화번호(하이픈 있어도) · 부서로 맞음
assert.equal(memberMatches(m, '김하준'), true)
assert.equal(memberMatches(m, '하준'), true)
assert.equal(memberMatches(m, '010-1234'), true)
assert.equal(memberMatches(m, '01012340000'), true)
assert.equal(memberMatches(m, '물류센터'), true)
// 낱말이 모두 맞아야 함
assert.equal(memberMatches(m, '김하준 0000'), true)
assert.equal(memberMatches(m, '김하준 9999'), false)
// 기업명으로만 맞은 사원은 사원 줄로 안 보임 (기업명 줄이 따로 있음)
assert.equal(memberMatches(m, '디버'), false)
assert.equal(memberMatches(m, '이서연'), false)

console.log('searchApi.test.ts OK')
