// 08 기업 상세의 계산 — 주소 쿼리 기본값 · 사원 거르기 · 표 줄 · 위 줄의 사실. React를 모르는 순수 함수 (실행해서 확인: companyView.test.ts)
import { fmtDate, fmtPhone } from '@/shared/lib/format'
import { phoneDigits } from '@/shared/lib/search'
import type { Member } from '../api/companyApi'

// t 탭(사원 · 청구) · q 사원 검색 · d 부서('' 전체 · 'none' 부서 없음 · 번호) · r 구분('' 전체 · 'manager')
// m 달('' 이번 달) · cq 청구 검색 · o 고른 청구 건(주문 번호)
export const COMPANY_PARAMS = { t: '', q: '', d: '', r: '', m: '', cq: '', o: '' }

export const isManager = (m: Member) => m.membership.role === 'ORG_ADMIN'

const inDept = (m: Member, dept: string) => {
  if (dept === '') return true
  if (dept === 'none') return m.membership.departmentSeq === null
  return m.membership.departmentSeq === Number(dept)
}

/** 사원 탭: 전체를 받아 부서 · 구분 · 검색으로 거름 (서버 사원 목록엔 부서 조건이 없음)
 *  byDept = 부서만 거른 것(구분 탭의 건수), filtered = 거기서 구분 · 검색까지. q는 소문자 · NFC로 다듬은 검색어 */
export function filterMembers(
  everyone: Member[],
  f: { dept: string; managersOnly: boolean; q: string },
) {
  const digits = /^[0-9-]+$/.test(f.q) ? phoneDigits(f.q) : ''
  const hit = (m: Member) =>
    !f.q ||
    m.customer.name.toLowerCase().includes(f.q) ||
    m.membership.employeeNo.toLowerCase().includes(f.q) ||
    (!!digits && m.customer.phoneNumber.includes(digits))
  const byDept = everyone.filter((m) => inDept(m, f.dept))
  return {
    byDept,
    filtered: byDept.filter((m) => (!f.managersOnly || isManager(m)) && hit(m)),
  }
}

/** 사원 표 한 줄 (dept: null = 부서 없음, '' = 부서 이름을 아직 못 받음) */
export const memberRow = (m: Member, deptName: Map<number, string>) => ({
  id: m.membership.membershipSeq,
  employeeNo: m.membership.employeeNo,
  name: m.customer.name,
  manager: isManager(m),
  dept:
    m.membership.departmentSeq === null ? null : (deptName.get(m.membership.departmentSeq) ?? ''),
  phone: fmtPhone(m.customer.phoneNumber),
  address: m.customer.address
    ? `${m.customer.address.roadAddress} ${m.customer.address.detailAddress ?? ''}`.trim()
    : null,
  member: m,
})

/** 기업 이름 아래 줄 — 등록일(예전 기업은 없음) · 담당자 수(사원을 받기 전엔 빈칸) · 사원 수 */
export const companyFacts = (
  company: { createdAt: string | null; memberCount: number } | undefined,
  managerCount: number | null,
) =>
  company
    ? [
        ...(company.createdAt ? [['등록', fmtDate(company.createdAt)]] : []),
        ['담당자', managerCount === null ? '' : `${managerCount}명`],
        ['사원', `${company.memberCount}명`],
      ]
    : []
