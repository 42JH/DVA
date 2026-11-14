// 실행: npx tsx --tsconfig tsconfig.app.json src/features/company/hooks/memberForm.test.ts  (프레임워크 없이 assert만)
import assert from 'node:assert/strict'
import type { Member } from '@/features/company/api/companyApi'
import { memberChecks, memberErrors, memberReady, type MemberFormValues } from './memberForm'

const member = (
  seq: number,
  no: string,
  name: string,
  phone: string,
  role: Member['membership']['role'] = 'MEMBER',
  address: Member['customer']['address'] = null,
): Member => ({
  membership: {
    membershipSeq: seq,
    customerSeq: seq + 100,
    organizationSeq: 1,
    departmentSeq: null,
    employeeNo: no,
    role,
    status: 'ACTIVE',
  },
  customer: { customerSeq: seq + 100, name, phoneNumber: phone, address, status: 'ACTIVE' },
})
const home = {
  roadAddress: '서울 강남구 테헤란로 152',
  jibunAddress: '역삼동 737',
  detailAddress: '2층',
  dongName: '역삼동',
  postalCode: '06236',
}
const boss = member(1, '001', '황지안', '01011112222', 'ORG_ADMIN', home)
const staff = member(2, '002', '신예린', '01033334444')
const all = [boss, staff]
const form = (over: Partial<MemberFormValues> = {}): MemberFormValues => ({
  employeeNo: '003',
  name: '새사원',
  phone: '010-5555-6666',
  role: 'MEMBER',
  dept: '',
  detail: '',
  ...over,
})
const picked = {
  roadAddress: '서울 마포구 독막로 301',
  jibunAddress: '상수동 1',
  dongName: '상수동',
  postalCode: '04071',
}

// 추가: 주소를 골라야 보낼 수 있음. 고르면 상세주소(앞뒤 공백 없이)와 함께 보냄
const add = memberChecks(form(), null, null, all)
assert.deepEqual([add.noAddress, memberReady(add)], [true, false])
const addOk = memberChecks(form({ detail: ' 3층 ' }), picked, null, all)
assert.equal(memberReady(addOk), true)
assert.deepEqual(addOk.address, { ...picked, detailAddress: '3층' })

// 이미 있는 사번 · 다른 사원이 쓰는 번호
const dup = memberChecks(form({ employeeNo: ' 001 ', phone: '010-3333-4444' }), picked, null, all)
assert.deepEqual(
  [dup.sameNo?.customer.name, dup.samePhone?.customer.name, memberReady(dup)],
  ['황지안', '신예린', false],
)
assert.match(memberErrors(dup, '010-3333-4444').employeeNo ?? '', /이미 있는 사번입니다 \(황지안\)/)
assert.match(memberErrors(dup, '010-3333-4444').phone ?? '', /신예린\(사번 002\)/)
// 상세주소만 있고 주소가 없음
assert.equal(memberChecks(form({ detail: '3층' }), null, null, all).detailWithoutRoad, true)

// 수정: 아무것도 안 바꾸면 [저장] 꺼짐. 자기 사번 · 번호는 겹침이 아님
const same = form({
  employeeNo: '001',
  name: '황지안',
  phone: '010-1111-2222',
  role: 'ORG_ADMIN',
  detail: '2층',
})
const edit = memberChecks(same, null, boss, all)
assert.deepEqual(
  [edit.sameNo, edit.samePhone, edit.infoChanged, edit.changed, edit.address, memberReady(edit)],
  [undefined, undefined, false, false, null, false],
)
// 상세주소만 바꿈 → 원래 주소에 상세주소만 바꿔 보냄 (사원 등록은 다시 안 함)
const moved = memberChecks({ ...same, detail: '7층' }, null, boss, all)
assert.deepEqual(
  [moved.infoChanged, moved.changed, moved.address, memberReady(moved)],
  [false, true, { ...home, detailAddress: '7층' }, true],
)
// 부서가 바뀌면 다시 등록
assert.equal(memberChecks({ ...same, dept: '26' }, null, boss, all).infoChanged, true)

// 마지막 담당자는 사원으로 못 내림. 담당자가 둘이면 됨
const down = memberChecks({ ...same, role: 'MEMBER' }, null, boss, all)
assert.deepEqual([down.lastManager, memberReady(down)], [true, false])
assert.equal(memberErrors(down, same.phone).role, '기업마다 담당자가 1명 이상 있어야 합니다.')
const two = [boss, { ...staff, membership: { ...staff.membership, role: 'ORG_ADMIN' as const } }]
assert.equal(memberChecks({ ...same, role: 'MEMBER' }, null, boss, two).lastManager, false)

console.log('memberForm.test ok')
