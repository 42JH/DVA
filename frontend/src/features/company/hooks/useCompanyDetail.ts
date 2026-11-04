import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { fmtPhone, fmtShortDate } from '@/shared/lib/format'
import { ymd } from '@/shared/lib/dateRange'
import { pageCount, pageSlice } from '@/shared/api/paging'
import { matchKo, phoneDigits } from '@/shared/lib/search'
import { useListParams } from '@/shared/lib/useListParams'
import { ApiError } from '@/shared/api/client'
import { companyQueries, removeMember, type Member } from '@/features/company/api/companyApi'
import { errorText } from '@/features/company/labels'

const PAGE_SIZE = 10 // 디자인: 한 쪽 10명
const DEFAULTS = { q: '' }

export interface MemberRow {
  id: number // membershipSeq
  employeeNo: string
  name: string
  leader: boolean // '대표자' 태그 (여러 명 가능)
  inactive: boolean // '비활성' 태그 (11/01 디자인 추가 d)
  phone: string // '010-2481-3375'
  address: string // 도로명 — 없으면 '없음' (보기만, 11/01 결정 A)
  detail: string // 상세주소 — 없으면 '없음'
  member: Member // 수정 창에 그대로 넘김
}

/** 창 — 한 번에 하나 (구분 유니온) */
export type MemberModal =
  | { kind: 'add' }
  | { kind: 'edit'; member: Member }
  | { kind: 'delete'; member: Member }
  | { kind: 'csv' }
  | null

/** 08 기업 상세 훅 — 기업 · 제목 줄(사원 수 · 대표자) · 사원 표(쪽은 URL) · 창 상태 · 사원 삭제 */
export function useCompanyDetail(id: number) {
  const { params, page, set } = useListParams(DEFAULTS)
  const qc = useQueryClient()
  const [modal, setModal] = useState<MemberModal>(null)

  const company = useQuery(companyQueries.detail(id))
  const members = useQuery({
    ...companyQueries.members(id, { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  })
  // 대표자는 쪽과 상관없이 전체에서 — 제목 줄 '대표자 이서미 외 1명' (11/01 디자인 추가 c)
  const all = useQuery(companyQueries.allMembers(id))
  const leaders = (all.data ?? [])
    .filter((m) => m.membership.role === 'ORG_ADMIN' && m.membership.status === 'ACTIVE')
    .map((m) => m.customer.name)

  // 사원 검색 (11/05): 서버에 검색 조건이 없어 대표자용으로 받아 둔 전체에서 거름 (사원명 초성 · 사번 · 전화번호 숫자)
  const q = params.q.trim()
  const digits = phoneDigits(q)
  const hit = q
    ? (all.data ?? []).filter(
        (m) =>
          matchKo(m.customer.name, q) ||
          m.membership.employeeNo.includes(q) ||
          (!!digits && m.customer.phoneNumber.includes(digits)),
      )
    : null
  const shown = hit ? pageSlice(hit, page, PAGE_SIZE).rows : (members.data?.data ?? [])

  const total = hit ? hit.length : (members.data?.total_count ?? 0)
  const pages = pageCount(total, PAGE_SIZE)
  useEffect(() => {
    if ((hit ? all.data : members.data) && page > pages) set({ page: pages }) // 마지막 쪽의 마지막 사원을 지우면 앞쪽으로
  }, [hit, all.data, members.data, page, pages, set])

  const remove = useMutation({
    mutationFn: (m: Member) => removeMember(m.membership.membershipSeq),
    onSuccess: async () => {
      // 이 기업(상세 · 사원 · 사원 수 · 전체) + 목록 화면의 사원 수까지 한 번에
      await qc.invalidateQueries({ queryKey: companyQueries.all() })
      setModal(null)
    },
    onError: () => setModal(null),
  })

  const rows: MemberRow[] = shown.map((m) => ({
    id: m.membership.membershipSeq,
    employeeNo: m.membership.employeeNo,
    name: m.customer.name,
    leader: m.membership.role === 'ORG_ADMIN',
    inactive: m.membership.status === 'INACTIVE',
    phone: fmtPhone(m.customer.phoneNumber),
    address: m.customer.address?.roadAddress ?? '없음',
    detail: m.customer.address?.detailAddress || '없음', // 빈 문자열도 '없음'
    member: m,
  }))

  return {
    notFound: company.error instanceof ApiError && company.error.status === 404,
    loadError:
      (company.error ?? members.error)
        ? '기업 정보를 불러오지 못했습니다. 새로고침해 주세요.'
        : null,
    name: company.data?.name ?? '',
    inactive: company.data?.status === 'INACTIVE',
    // 제목 줄 '사원 12명 · 등록 05.22 · 대표자 이서미 외 1명' (디자인 + 대표자, 11/01)
    summary: [
      company.data ? `사원 ${company.data.memberCount}명` : null,
      company.data?.createdAt
        ? `등록 ${fmtShortDate(ymd(new Date(company.data.createdAt)))}`
        : null,
      leaders.length === 0
        ? null
        : `대표자 ${leaders[0]}${leaders.length > 1 ? ` 외 ${leaders.length - 1}명` : ''}`,
    ]
      .filter(Boolean)
      .join(' · '),
    total,

    q: params.q,
    setQ: (v: string) => set({ q: v }), // 쪽은 1로
    rows,
    isLoading: hit ? all.isPending : members.isPending,
    page: Math.min(page, pages),
    pages,
    setPage: (p: number) => set({ page: p }),

    modal,
    openAdd: () => setModal({ kind: 'add' }),
    openEdit: (m: Member) => setModal({ kind: 'edit', member: m }),
    askDelete: (m: Member) => setModal({ kind: 'delete', member: m }),
    openCsv: () => setModal({ kind: 'csv' }),
    close: () => setModal(null),

    confirmDelete: () => modal?.kind === 'delete' && remove.mutate(modal.member),
    deleting: remove.isPending,
    deleteError: remove.error ? errorText(remove.error, '삭제') : null,
  }
}
