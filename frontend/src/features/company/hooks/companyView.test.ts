// 실행: npx tsx --tsconfig tsconfig.app.json src/features/company/hooks/companyView.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { Member } from '../api/companyApi'
import { companyFacts, filterMembers, memberRow } from './companyView'

const member = (
  seq: number,
  name: string,
  phone: string,
  dept: number | null,
  role: Member['membership']['role'] = 'MEMBER',
): Member => ({
  membership: {
    membershipSeq: seq,
    customerSeq: seq,
    organizationSeq: 1,
    departmentSeq: dept,
    employeeNo: `A00${seq}`,
    role,
    status: 'ACTIVE',
  },
  customer: { customerSeq: seq, name, phoneNumber: phone, address: null, status: 'ACTIVE' },
})
const everyone = [
  member(1, '황지안', '01096584649', 26, 'ORG_ADMIN'),
  member(2, '신예린', '01028007973', 27),
  member(3, '조민혁', '01028015892', null),
  member(4, '신아린', '01096560892', 26),
]
const names = (f: Parameters<typeof filterMembers>[1]) => {
  const r = filterMembers(everyone, f)
  return [r.byDept.map((m) => m.customer.name), r.filtered.map((m) => m.customer.name)]
}
const all = { dept: '', managersOnly: false, q: '' }

// 부서: 전체 · 부서 없음 · 번호
assert.deepEqual(names(all)[1], ['황지안', '신예린', '조민혁', '신아린'])
assert.deepEqual(names({ ...all, dept: 'none' })[1], ['조민혁'])
assert.deepEqual(names({ ...all, dept: '26' })[1], ['황지안', '신아린'])
// 구분 · 검색은 부서로 거른 것 안에서 — byDept(구분 탭의 건수)는 그대로
assert.deepEqual(names({ dept: '26', managersOnly: true, q: '' }), [
  ['황지안', '신아린'],
  ['황지안'],
])
// 검색: 이름 · 사번(소문자로 다듬은 검색어) · 숫자만 치면 전화번호
assert.deepEqual(names({ ...all, q: '신' })[1], ['신예린', '신아린'])
assert.deepEqual(names({ ...all, q: 'a003' })[1], ['조민혁'])
assert.deepEqual(names({ ...all, q: '2801-5892' })[1], ['조민혁'])
assert.deepEqual(names({ ...all, q: '없는사람' })[1], [])

// 표 줄: 부서 없음 = null, 이름을 아직 못 받은 부서 = '', 주소 없음 = null
const deptName = new Map([[26, '총무팀']])
assert.deepEqual(
  everyone.slice(0, 3).map((m) => memberRow(m, deptName).dept),
  ['총무팀', '', null],
)
const row = memberRow(
  {
    ...everyone[0],
    customer: {
      ...everyone[0].customer,
      address: {
        roadAddress: '서울 강남구 테헤란로 152',
        jibunAddress: '',
        dongName: '',
        postalCode: '06236',
      },
    },
  },
  deptName,
)
assert.deepEqual(
  [row.manager, row.phone, row.address],
  [true, '010-9658-4649', '서울 강남구 테헤란로 152'],
)
assert.equal(memberRow(everyone[1], deptName).address, null)

// 위 줄: 등록일이 없는 예전 기업은 등록을 빼고, 사원을 받기 전엔 담당자 수가 빈칸
assert.deepEqual(companyFacts(undefined, 3), [])
assert.deepEqual(companyFacts({ createdAt: null, memberCount: 18 }, null), [
  ['담당자', ''],
  ['사원', '18명'],
])
assert.deepEqual(
  companyFacts({ createdAt: '2026-06-11T00:00:00+09:00', memberCount: 18 }, 1).map((f) => f[0]),
  ['등록', '담당자', '사원'],
)
