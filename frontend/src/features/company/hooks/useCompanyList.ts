import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { pageCount } from '@/shared/api/paging'
import { ymd } from '@/shared/lib/dateRange'
import { fmtShortDate } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { companyQueries, deleteCompany } from '@/features/company/api/companyApi'
import { BILLING_LABEL, errorText } from '@/features/company/labels'

const PAGE_SIZE = 10 // 디자인: 한 쪽 10곳
const SEARCH_DELAY_MS = 300 // 서버 검색이라 칠 때마다 요청하지 않게 — 멈추고 0.3초 뒤
const DEFAULTS = { q: '' }

export interface CompanyRow {
  id: number
  name: string
  inactive: boolean // '비활성' 태그
  members: number // 사원 수 (서버 memberCount)
  date: string // 등록일 '03.04' · 다른 해 '2025.12.29' · 없으면 '—'
  billing: string // 월결제 '사용' · '미사용'
}

/** 08 기업 목록 훅 — 검색 · 쪽(URL) · 목록 · 사원 수 · 체크 선택 · 여러 곳 삭제 · CSV 창 열기 */
export function useCompanyList() {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  const navigate = useNavigate()

  // 검색칸은 바로 바뀌고(URL), 요청은 멈춘 뒤에
  const [searched, setSearched] = useState(params.q)
  useEffect(() => {
    const t = setTimeout(() => setSearched(params.q), SEARCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [params.q])

  const list = useQuery({
    ...companyQueries.list({ q: searched, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    placeholderData: keepPreviousData, // 쪽 · 검색이 바뀌는 동안 이전 표 유지 (깜빡임 방지)
  })
  const companies = list.data?.data ?? []

  const total = list.data?.total_count ?? 0
  const pages = pageCount(total, PAGE_SIZE)
  useEffect(() => {
    if (list.data && page > pages) set({ page: pages }) // 지워서 마지막 쪽이 비면 앞쪽으로
  }, [list.data, page, pages, set])

  // 체크는 지금 보이는 줄 안에서만 — 쪽 · 검색이 바뀌면 안 보이는 기업이 지워지지 않게 걸러 씀
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const visible = new Set(companies.map((c) => c.organizationSeq))
  const selected = new Set([...checked].filter((id) => visible.has(id)))

  const [confirming, setConfirming] = useState(false) // 삭제 확인 창
  const [csvOpen, setCsvOpen] = useState(false) // CSV로 기업 등록 창
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // 삭제 API는 한 곳씩 → 차례로. 중간에 실패하면 멈추고 몇 곳 지웠는지 알림 (11/01 결정 2)
  const removeSelected = async () => {
    const ids = [...selected]
    setDeleting(true)
    setDeleteError(null)
    let done = 0
    try {
      for (const id of ids) {
        await deleteCompany(id)
        done++
      }
    } catch (e) {
      setDeleteError(`${ids.length}곳 중 ${done}곳 삭제했습니다. 나머지는 ${errorText(e, '삭제')}`)
    } finally {
      setDeleting(false)
      setConfirming(false)
      setChecked(new Set())
      await qc.invalidateQueries({ queryKey: companyQueries.all() })
    }
  }

  const rows: CompanyRow[] = companies.map((c) => ({
    id: c.organizationSeq,
    name: c.name,
    inactive: c.status === 'INACTIVE',
    members: c.memberCount,
    date: c.createdAt ? fmtShortDate(ymd(new Date(c.createdAt))) : '—',
    billing: BILLING_LABEL(c.monthlyBillingEnabled),
  }))

  return {
    q: params.q,
    setQ: (q: string) => set({ q }), // 쪽은 1로
    rows,
    total,
    isLoading: list.isPending,
    loadError: list.error ? '기업 목록을 불러오지 못했습니다. 새로고침해 주세요.' : null,
    page: Math.min(page, pages),
    pages,
    setPage: (p: number) => set({ page: p }),

    selected,
    toggle: (id: number) =>
      setChecked((s) => {
        const next = new Set(s)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    toggleAll: () =>
      setChecked(selected.size === rows.length ? new Set() : new Set(rows.map((r) => r.id))),

    confirming,
    askDelete: () => setConfirming(true), // [삭제] — 고른 게 없으면 버튼이 꺼져 있음
    cancelDelete: () => setConfirming(false),
    removeSelected,
    deleting,
    deleteError,
    selectedNames: rows.filter((r) => selected.has(r.id)).map((r) => r.name),

    open: (id: number) => navigate(`/companies/${id}`), // 줄 클릭 → 상세

    csvOpen,
    openCsv: () => setCsvOpen(true),
    closeCsv: () => setCsvOpen(false),
  }
}
