import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { pageCount, pageSlice } from '@/shared/api/paging'
import { fmtDate } from '@/shared/lib/format'
import { useListParams } from '@/shared/lib/useListParams'
import { matchKo } from '@/shared/lib/search'
import {
  companyQueries,
  deleteCompanies,
  deleteCompany,
  renameCompany,
} from '@/features/company/api/companyApi'
import { BILLING_LABEL, errorText } from '@/features/company/labels'

const PAGE_SIZE = 10 // 디자인: 한 쪽 10곳
const DEFAULTS = { q: '' }

interface CompanyRow {
  id: number
  name: string
  inactive: boolean // '비활성' 태그
  members: number // 사원 수 (서버 memberCount)
  date: string // 등록일 '2026-03-04' (날짜 형식) · 없으면 '—'
  billing: string // 월결제 '사용' · '미사용'
}

/** 08 기업 목록 훅 — 검색 · 쪽(URL) · 목록 · 사원 수 · 체크 선택 · 여러 곳 삭제 · CSV 창 열기 */
export function useCompanyList(size = PAGE_SIZE) {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  const navigate = useNavigate()

  // 검색어가 없으면 서버가 쪽을 나눔. 있으면 기업 전체를 받아 09 · 04와 같은 규칙(초성 · 띄어쓰기 무시)으로 앞에서 거름 (11/02)
  const q = useDeferredValue(params.q.trim()) // 칠 때마다 거르니 입력이 먼저, 목록은 한 박자 늦게 (09와 같음)
  const searching = q !== ''
  const list = useQuery({
    ...companyQueries.list({ q: '', limit: size, offset: (page - 1) * size }),
    placeholderData: keepPreviousData, // 쪽이 바뀌는 동안 이전 표 유지 (깜빡임 방지)
    enabled: !searching,
  })
  const pool = useQuery({ ...companyQueries.pool(), enabled: searching })
  const hit = searching ? (pool.data ?? []).filter((c) => matchKo(c.name, q)) : null
  const companies = hit ? pageSlice(hit, page, size).rows : (list.data?.data ?? [])

  const total = hit ? hit.length : (list.data?.total_count ?? 0)
  const pages = pageCount(total, size)
  const loaded = searching ? !!pool.data : !!list.data
  useEffect(() => {
    if (loaded && page > pages) set({ page: pages }) // 지워서 마지막 쪽이 비면 앞쪽으로
  }, [loaded, page, pages, set])

  // 체크는 지금 보이는 줄 안에서만 — 쪽 · 검색이 바뀌면 안 보이는 기업이 지워지지 않게 걸러 씀
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const visible = new Set(companies.map((c) => c.organizationSeq))
  const selected = new Set([...checked].filter((id) => visible.has(id)))

  const [confirming, setConfirming] = useState(false) // 삭제 확인 창
  const [csvOpen, setCsvOpen] = useState(false) // CSV로 기업 등록 창
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // 고른 기업을 한 번에 (DELETE /companies) — 한 곳이라도 실패하면 서버가 전체를 되돌려 일부만 지워지지 않음. 고르기는 보이는 쪽 안(최대 100곳)
  const removeSelected = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteCompanies([...selected])
    } catch (e) {
      setDeleteError(`한 곳도 지우지 않았습니다. ${errorText(e, '삭제')}`)
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
    date: c.createdAt ? fmtDate(c.createdAt) : '—',
    billing: BILLING_LABEL(c.monthlyBillingEnabled),
  }))

  // 줄의 [삭제] — 한 곳만
  const removeOne = useMutation({
    mutationFn: (id: number) => deleteCompany(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: companyQueries.all() }),
  })
  // 줄의 [수정] — 기업명 (11/11 사용자)
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) => renameCompany(id, name),
    onSuccess: () => qc.invalidateQueries({ queryKey: companyQueries.all() }),
  })

  return {
    removeOne,
    rename,
    q: params.q,
    setQ: (v: string) => set({ q: v }), // 쪽은 1로
    rows,
    total,
    isLoading: searching ? pool.isPending : list.isPending,
    loadError: (searching ? pool.error : list.error)
      ? '기업 목록을 불러오지 못했습니다. 새로고침해 주세요.'
      : null,
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
