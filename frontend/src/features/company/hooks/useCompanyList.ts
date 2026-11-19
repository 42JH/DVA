import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useState } from 'react'
import { pageCount, pageSlice } from '@/shared/api/paging'
import { fmtDate } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { matchKo } from '@/shared/lib/search'
import { companyQueries } from '@/features/company/api/companyApi'

const PAGE_SIZE = 10 // 디자인: 한 쪽 10곳
const DEFAULTS = { q: '' }

interface CompanyRow {
  id: number
  name: string
  managers: string[] // 담당자 이름 — 백엔드 칸이 오기 전엔 빈 배열
  members: number // 사원 수 (서버 memberCount)
  departments: number | null // 부서 수 — 백엔드 칸이 오기 전엔 null
  amount: number | null // 이번 달 청구액 — 백엔드 칸이 오기 전엔 null
  date: string // 등록일 '2026-03-04' · 없으면 ''
}

/** 08 기업 목록 훅 — 검색 · 쪽(URL) · 목록 · CSV 창. 줄을 누르면 상세(삭제 · 이름 수정은 상세에서) */
export function useCompanyList(size = PAGE_SIZE) {
  const { params, page, set } = useListParams(DEFAULTS)

  // 검색어가 없으면 서버가 쪽을 나눔. 있으면 기업 전체를 받아 초성 · 띄어쓰기 무시로 앞에서 거름
  const q = useDeferredValue(params.q.trim())
  const searching = q !== ''
  const list = useQuery({
    ...companyQueries.list({ q: '', limit: size, offset: (page - 1) * size }),
    placeholderData: keepPreviousData,
    enabled: !searching,
  })
  const pool = useQuery({ ...companyQueries.pool(), enabled: searching })
  const hit = searching ? (pool.data ?? []).filter((c) => matchKo(c.name, q)) : null
  const companies = hit ? pageSlice(hit, page, size).rows : (list.data?.data ?? [])

  const total = hit ? hit.length : (list.data?.total_count ?? 0)
  const pages = pageCount(total, size)
  const loaded = searching ? !!pool.data : !!list.data
  useEffect(() => {
    if (loaded && page > pages) set({ page: pages }) // 상세에서 지우고 돌아와 마지막 쪽이 비면 앞쪽으로
  }, [loaded, page, pages, set])

  const [csvOpen, setCsvOpen] = useState(false)

  const rows: CompanyRow[] = companies.map((c) => ({
    id: c.organizationSeq,
    name: c.name,
    managers: c.managerNames ?? [],
    members: c.memberCount,
    departments: c.departmentCount ?? null,
    amount: c.monthlyAmount ?? null,
    date: c.createdAt ? fmtDate(c.createdAt) : '',
  }))

  return {
    q: params.q,
    setQ: (v: string) => set({ q: v }), // 쪽은 1로
    rows,
    total,
    isLoading: searching ? pool.isPending : list.isPending,
    loadError: (searching ? pool.error : list.error)
      ? '기업 목록을 불러오지 못했습니다. 새로고침해 주세요.'
      : null,
    page: Math.min(page, pages),
    setPage: (p: number) => set({ page: p }),

    csvOpen,
    openCsv: () => setCsvOpen(true),
    closeCsv: () => setCsvOpen(false),
  }
}
