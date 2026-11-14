import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { pageCount, pageSlice } from '@/shared/api/paging'
import { useDebounced } from '@/shared/lib/useDebounced'
import { useListParams } from '@/shared/lib/useListParams'
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
import { COMPANY_PARAMS, companyFacts, filterMembers, isManager, memberRow } from './companyView'
import { useCompanyCharges } from './useCompanyCharges'

const PAGE_SIZE = 10

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

/** 08 기업 상세 훅 (11/11 재설계) — 청구액(달) · 부서 · 사원 탭 · 청구 내역 탭 · 창 */
export function useCompanyDetail(id: number, size = PAGE_SIZE) {
  const list = useListParams(COMPANY_PARAMS)
  const { params, page, set } = list
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [modal, setModal] = useState<Modal>(null)
  const tab: 'members' | 'charges' = params.t === 'charges' ? 'charges' : 'members'

  const company = useQuery(companyQueries.detail(id))
  const all = useQuery(companyQueries.allMembers(id))
  const depts = useQuery(companyQueries.departments(id))
  const everyone = all.data ?? []
  const managers = everyone.filter(isManager)
  const bills = useCompanyCharges(id, size, list) // 달 · 청구액 · 청구 내역 탭

  // ── 사원 탭
  const q = useDebounced(params.q.trim().normalize('NFC').toLowerCase())
  const { byDept, filtered } = filterMembers(everyone, {
    dept: params.d,
    managersOnly: params.r === 'manager',
    q,
  })

  const total = tab === 'members' ? filtered.length : bills.total
  const pages = pageCount(total, size)
  const loaded = tab === 'members' ? !!all.data : bills.loaded
  useEffect(() => {
    if (loaded && page > pages) set({ page: pages })
  }, [loaded, page, pages, set])

  const deptName = new Map((depts.data ?? []).map((d) => [d.departmentSeq, d.name]))
  const rows = pageSlice(filtered, page, size).rows.map((m) => memberRow(m, deptName))

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

  const memberCount = company.data?.memberCount ?? everyone.length
  const noDept = memberCount - (depts.data ?? []).reduce((n, d) => n + d.memberCount, 0)

  return {
    notFound: company.error instanceof ApiError && company.error.status === 404,
    loadError: company.error ? '기업 정보를 불러오지 못했습니다. 새로고침해 주세요.' : null,
    name: company.data?.name ?? '',
    facts: companyFacts(company.data, all.data ? managers.length : null),

    ...bills.view,

    // 부서
    depts: depts.data ?? [],
    dept: params.d,
    allCount: memberCount,
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
