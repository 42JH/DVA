// 08 사원 추가 · 수정 창의 계산 — 같은 사번 · 같은 번호 · 마지막 담당자 · 보낼 주소 · 칸 아래 문구
// React를 모르는 순수 함수 (실행해서 확인: memberForm.test.ts). 상태 · 요청은 useMemberForm
import type { SearchedAddress } from '@/shared/ui'
import type { CustomerAddress, Member } from '../api/companyApi'
import { phoneDigits, phoneError } from '../csvMembers'

export type Role = Member['membership']['role']
/** 창의 칸 값 */
export interface MemberFormValues {
  employeeNo: string
  name: string
  phone: string // 010-1234-5678 모양 (CSV와 같은 모양, 11/06)
  role: Role
  dept: string // '' = 부서 없음
  detail: string // 상세주소
}

/** 칸 값에서 나오는 것 전부. target = 수정할 사원(추가면 null), picked = 새로 고른 주소, all = 그 기업의 전체 사원 */
export function memberChecks(
  form: MemberFormValues,
  picked: SearchedAddress | null,
  target: Member | null,
  all: Member[],
) {
  const before = target?.customer.address ?? null // 지금 고객 주소 (없으면 null)
  const no = form.employeeNo.trim()
  const name = form.name.trim()
  const digits = phoneDigits(form.phone)
  const detail = form.detail.trim()
  const deptSeq = form.dept === '' ? null : Number(form.dept)
  const road = picked?.roadAddress ?? before?.roadAddress ?? ''
  // 보낼 주소(전체 교체 객체): 새로 골랐으면 검색 결과, 상세주소만 바꿨으면 원래 주소
  let address: CustomerAddress | null = null
  if (picked) address = { ...picked, detailAddress: detail }
  else if (before && detail !== (before.detailAddress ?? ''))
    address = { ...before, detailAddress: detail }
  // 이름 · 전화 · 부서가 바뀌면 다시 등록 (추가는 늘)
  const infoChanged =
    target === null ||
    name !== target.customer.name ||
    digits !== target.customer.phoneNumber ||
    deptSeq !== target.membership.departmentSeq
  const roleChanged = target !== null && form.role !== target.membership.role
  return {
    no,
    name,
    digits,
    deptSeq,
    road,
    address,
    infoChanged,
    changed: infoChanged || roleChanged || address !== null, // 주소 · 상세주소만 바꿔도 저장
    // 추가에서 이미 있는 사번 → 서버는 새로 만들지 않고 그 사원을 덮어씀 → 막고 [수정]으로 안내
    sameNo: target ? undefined : all.find((m) => m.membership.employeeNo === no),
    // 같은 기업의 다른 사원이 쓰는 번호 → 서버가 전체 거절 → 미리 알림
    samePhone: all.find(
      (m) =>
        m.customer.phoneNumber === digits &&
        m.membership.membershipSeq !== target?.membership.membershipSeq,
    ),
    detailWithoutRoad: detail !== '' && road === '', // 상세주소만 있으면 저장할 주소가 없음
    // 주소 필수 — CSV 추가와 같은 규칙 · 상단바 사원 검색(DIR-01)이 주소 있는 사원만 찾음.
    // 수정에서 원래 주소가 있으면 road가 그 주소라 통과, 없으면 새로 골라야 함
    noAddress: road === '',
    // 기업마다 담당자 1명 이상 — 마지막 담당자를 사원으로 내리지 못하게
    lastManager:
      target?.membership.role === 'ORG_ADMIN' &&
      form.role === 'MEMBER' &&
      all.filter((m) => m.membership.role === 'ORG_ADMIN').length <= 1,
  }
}
export type MemberChecks = ReturnType<typeof memberChecks>

/** 칸 아래 문구 */
export const memberErrors = (c: MemberChecks, phone: string) => ({
  employeeNo: c.sameNo
    ? `이미 있는 사번입니다 (${c.sameNo.customer.name}). 정보를 바꾸려면 [수정]을 눌러 주세요.`
    : undefined,
  phone:
    (phone && phoneError(c.digits)) ||
    (c.samePhone
      ? `${c.samePhone.customer.name}(사번 ${c.samePhone.membership.employeeNo}) 님이 쓰는 번호입니다.`
      : undefined),
  detail: c.detailWithoutRoad ? '주소를 먼저 검색해 골라 주세요.' : undefined,
  role: c.lastManager ? '기업마다 담당자가 1명 이상 있어야 합니다.' : undefined,
})

/** 보낼 수 있나 — 수정에서 아무것도 안 바꿨으면 [저장] 꺼짐 */
export const memberReady = (c: MemberChecks) =>
  c.no !== '' &&
  c.name !== '' &&
  phoneError(c.digits) === null &&
  !c.sameNo &&
  !c.samePhone &&
  !c.detailWithoutRoad &&
  !c.noAddress &&
  !c.lastManager &&
  c.changed
