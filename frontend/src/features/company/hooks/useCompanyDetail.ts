import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { fmtDate, fmtPhone } from '@/shared/lib/format'
import { pageCount, pageSlice } from '@/shared/api/paging'
import { addMonths, todayYmd } from '@/shared/lib/dateRange'
import { useDebounced } from '@/shared/lib/useDebounced'
import { useListParams } from '@/shared/lib/useListParams'
import { phoneDigits } from '@/shared/lib/search'
import { ApiError } from '@/shared/api/client'
import {
  companyQueries,
  createDepartment,
  deleteCompanies,
  deleteDepartment,
  removeMember,
  renameCompany,
  renameDepartment,
  type Department,
  type Member,
} from '@/features/company/api/companyApi'
import { errorText } from '@/features/company/labels'

const PAGE_SIZE = 10
// t 탭(사원 · 청구) · q 사원 검색 · d 부서('' 전체 · 'none' 부서 없음 · 번호) · r 구분('' 전체 · 'manager')
// m 달('' 이번 달) · cq 청구 검색 · o 고른 청구 건(주문 번호)
const DEFAULTS = { t: '', q: '', d: '', r: '', m: '', cq: '', o: '' }
const MONTH = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/ // 서버 BillingMonthQueryDto와 같은 형식

type Modal =
  | { kind: 'add' }
  | { kind: 'edit'; member: Member }
  | { kind: 'deleteMember'; member: Member; last: boolean } // last = 마지막 담당자 → 지우지 못함
  | { kind: 'csv' }
  | { kind: 'rename' }
  | { kind: 'deleteCompany' }
  | { kind: 'addDept' }
  | { kind: 'renameDept'; dept: Department }
  | { kind: 'deleteDept'; dept: Department }
  | null

const isManager = (m: Member) => m.membership.role === 'ORG_ADMIN'

/** 08 기업 상세 훅 (11/11 재설계) — 청구액(달) · 부서 · 사원 탭 · 청구 내역 탭 · 창 */
export function useCompanyDetail(id: number, size = PAGE_SIZE) {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [modal, setModal] = useState<Modal>(null)
  const tab: 'members' | 'charges' = params.t === 'charges' ? 'charges' : 'members'

  const company = useQuery(companyQueries.detail(id))
  const all = useQuery(companyQueries.allMembers(id))
  const depts = useQuery(companyQueries.departments(id))
  const everyone = all.data ?? []
  const managers = everyone.filter(isManager)

  // ── 달 · 청구액 (기업은 월결제 고정. 그룹결제가 서버에서 없어지기 전까지 두 금액을 더함)
  const thisMonth = todayYmd().slice(0, 7)
  const month = MONTH.test(params.m) && params.m <= thisMonth ? params.m : thisMonth
  const goMonth = (m: string) => set({ m: m === thisMonth ? '' : m, o: '', page })
  const billing = useQuery(companyQueries.billing(id, month))
  const prev = useQuery(companyQueries.billing(id, addMonths(month, -1)))
  const sum = (b?: { monthlyAmount: number; groupBillingAmount: number }) =>
    b ? b.monthlyAmount + b.groupBillingAmount : null

  // ── 사원 탭: 전체를 받아 부서 · 구분 · 검색으로 거름 (서버 사원 목록엔 부서 조건이 없음)
  const q = useDebounced(params.q.trim().normalize('NFC').toLowerCase())
  const digits = /^[0-9-]+$/.test(q) ? phoneDigits(q) : ''
  const inDept = (m: Member) =>
    params.d === ''
      ? true
      : params.d === 'none'
        ? m.membership.departmentSeq === null
        : m.membership.departmentSeq === Number(params.d)
  const byDept = everyone.filter(inDept)
  const filtered = byDept.filter(
    (m) =>
      (params.r !== 'manager' || isManager(m)) &&
      (!q ||
        m.customer.name.toLowerCase().includes(q) ||
        m.membership.employeeNo.toLowerCase().includes(q) ||
        (!!digits && m.customer.phoneNumber.includes(digits))),
  )

  // ── 청구 내역 탭
  const charges = useQuery({
    ...companyQueries.charges(id, {
      month,
      q: params.cq.trim() || undefined,
      limit: size,
      offset: (page - 1) * size,
    }),
    placeholderData: keepPreviousData,
  })
  // 탭 이름 · 위 카드의 건수는 검색과 상관없이 그 달 전체
  const chargeCount = useQuery(companyQueries.charges(id, { month, limit: 1, offset: 0 }))

  const total = tab === 'members' ? filtered.length : (charges.data?.total_count ?? 0)
  const pages = pageCount(total, size)
  const loaded = tab === 'members' ? !!all.data : !!charges.data
  useEffect(() => {
    if (loaded && page > pages) set({ page: pages })
  }, [loaded, page, pages, set])

  const deptName = new Map((depts.data ?? []).map((d) => [d.departmentSeq, d.name]))
  const rows = pageSlice(filtered, page, size).rows.map((m) => ({
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
  }))
  const picked = charges.data?.data.find((c) => String(c.orderSeq) === params.o) ?? null

  // ── 저장
  const done = async () => {
    await qc.invalidateQueries({ queryKey: companyQueries.all() })
    setModal(null)
  }
  const act = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: done,
  })
  const run = (fn: () => Promise<unknown>) => act.mutate(fn)

  const noDept =
    (company.data?.memberCount ?? everyone.length) -
    (depts.data ?? []).reduce((n, d) => n + d.memberCount, 0)

  return {
    notFound: company.error instanceof ApiError && company.error.status === 404,
    loadError: company.error ? '기업 정보를 불러오지 못했습니다. 새로고침해 주세요.' : null,
    name: company.data?.name ?? '',
    facts: company.data
      ? [
          ...(company.data.createdAt ? [['등록', fmtDate(company.data.createdAt)]] : []),
          ['담당자', all.data ? `${managers.length}명` : ''],
          ['사원', `${company.data.memberCount}명`],
        ]
      : [],

    // 청구액 카드
    monthLabel: `${month.slice(0, 4)}년 ${Number(month.slice(5))}월`,
    monthNum: Number(month.slice(5)),
    prevMonth: () => goMonth(addMonths(month, -1)),
    nextMonth: month < thisMonth ? () => goMonth(addMonths(month, 1)) : undefined,
    amount: sum(billing.data),
    prevAmount: sum(prev.data),
    chargeTotal: chargeCount.data?.total_count ?? null,

    // 부서
    depts: depts.data ?? [],
    dept: params.d,
    allCount: company.data?.memberCount ?? everyone.length,
    noDeptCount: Math.max(0, noDept),
    pickDept: (d: string) => set({ d }),

    // 탭
    tab,
    setTab: (t: 'members' | 'charges') => set({ t: t === 'members' ? '' : t, o: '' }),
    page: Math.min(page, pages),
    total,
    setPage: (p: number) => set({ page: p }),

    // 사원 탭
    q: params.q,
    setQ: (v: string) => set({ q: v }),
    role: (params.r === 'manager' ? 'manager' : 'all') as 'all' | 'manager',
    setRole: (r: 'all' | 'manager') => set({ r: r === 'all' ? '' : r }),
    byDeptCount: byDept.length,
    byDeptManagers: byDept.filter(isManager).length,
    rows,
    membersLoading: all.isPending,
    showCharges: (name: string) => set({ t: 'charges', cq: name, o: '' }),

    // 청구 내역 탭
    cq: params.cq,
    setCq: (v: string) => set({ cq: v, o: '' }),
    charges: charges.data?.data ?? [],
    chargesSum: charges.data?.total_amount ?? null,
    chargesLoading: charges.isPending,
    chargesError: charges.error ? '청구 내역을 불러오지 못했습니다. 새로고침해 주세요.' : null,
    picked,
    pick: (orderSeq: number) =>
      set({ o: params.o === String(orderSeq) ? '' : String(orderSeq), page }),
    unpick: () => set({ o: '', page }),

    // 창
    modal,
    open: (m: Exclude<Modal, null>) => {
      act.reset()
      setModal(m)
    },
    askDeleteMember: (m: Member) => {
      act.reset()
      setModal({ kind: 'deleteMember', member: m, last: isManager(m) && managers.length <= 1 })
    },
    close: () => setModal(null),
    busy: act.isPending,
    error: act.error
      ? errorText(act.error, modal?.kind?.startsWith('delete') ? '삭제' : '저장')
      : null,

    renameCompany: (name: string) => run(() => renameCompany(id, name)),
    deleteCompany: () =>
      act.mutate(() => deleteCompanies([id]), {
        onSuccess: () => navigate('/companies', { replace: true }),
      }),
    deleteMember: (m: Member) => run(() => removeMember(m.membership.membershipSeq)),
    addDept: (name: string) => run(() => createDepartment(id, name)),
    renameDept: (d: Department, name: string) => run(() => renameDepartment(d.departmentSeq, name)),
    deleteDept: (d: Department) =>
      act.mutate(() => deleteDepartment(d.departmentSeq), {
        onSuccess: () => {
          if (params.d === String(d.departmentSeq)) set({ d: '' })
        },
      }),
  }
}
