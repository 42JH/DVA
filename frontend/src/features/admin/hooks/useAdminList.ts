import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { fmtDate, fmtDateTime } from '@/shared/lib/format'
import { pageCount } from '@/shared/api/paging'
import { useDebounced } from '@/shared/lib/useDebounced'
import { useListParams } from '@/shared/lib/useListParams'
import { useSession } from '@/shared/auth/useSession'
import {
  adminQueries,
  setAdminStatus,
  deleteAdmin,
  resetAdminPassword,
  type Admin,
  type AdminStatus,
} from '@/features/admin/api/adminApi'
import { ADMIN_TABS, ROLE_LABEL } from '@/features/admin/labels'

const PAGE_SIZE = 11 // 디자인: 한 쪽 11명
const DEFAULTS: { tab: AdminStatus; q: string } = { tab: 'ACTIVE', q: '' } // 첫 화면 = '관리자' 탭 (맨 앞 탭)

/** ⋮ 메뉴 항목 (비활성화 · 활성화는 11/01 백엔드 반영으로 연결) */
export type AdminAction = 'reset' | 'deactivate' | 'activate' | 'delete'

/** 확인 창 — 승인은 바로(디자인), 나머지 셋은 확인 후 */
type Confirming = { kind: 'reject' | 'delete' | 'reset' | 'deactivate'; admin: Admin } | null
type Job = {
  kind: 'approve' | 'reject' | 'delete' | 'reset' | 'deactivate' | 'activate'
  id: number
}

interface AdminRow {
  id: number
  name: string
  loginId: string
  role: string // '최고 관리자' · '일반 관리자'
  date: string // 가입 신청일 '2026.03.02' (승인된 계정은 계정이 생긴 날)
  lastLogin: string | null // 마지막 로그인 '2026-11-07 14:02', 로그인한 적 없으면 null
  pending: boolean // 승인 대기 탭 줄 → [승인] [거절]
  actions: AdminAction[] // ⋮ 메뉴 (빈 배열이면 ⋮ 없음)
}

// 서버가 막는 일은 처음부터 안 보임: 다른 최고 관리자 = 초기화만 (권한 변경 · 삭제 불가). 본인 줄은 목록에서 뺌
function actionsOf(a: Admin): AdminAction[] {
  if (a.status === 'PENDING') return []
  if (a.role === 'SYSTEM_ADMIN') return ['reset']
  return ['reset', a.status === 'INACTIVE' ? 'activate' : 'deactivate', 'delete']
}

const withoutMe = (tab: AdminStatus, n: number | undefined) =>
  n === undefined ? undefined : tab === 'ACTIVE' ? Math.max(0, n - 1) : n

/** 10 관리자 권한 관리 훅 — 탭 · 쪽(URL) · 목록 · 탭 건수 · 줄마다 할 수 있는 일 · 확인 창 · 요청 */
export function useAdminList(size = PAGE_SIZE) {
  const { params, page, set } = useListParams(DEFAULTS)
  // 주소창에 엉뚱한 값(?tab=foo)이 와도 기본 탭으로
  const tab = ADMIN_TABS.some((t) => t.key === params.tab) ? params.tab : DEFAULTS.tab
  const { me } = useSession()
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState<Confirming>(null)

  // 검색 (이름 · 아이디, 지금 탭 안에서) — 서버 q (11/08). 칠 때마다 묻지 않게 잠깐 기다림
  const q = useDebounced(params.q.trim().normalize('NFC').slice(0, 100))
  const list = useQuery(
    adminQueries.list({ status: tab, limit: size, offset: (page - 1) * size, q: q || undefined }),
  )
  // 탭 건수: 상태마다 1건만 받아 total_count만 씀
  const counts = useQueries({
    queries: ADMIN_TABS.map((t) => adminQueries.list({ status: t.key, limit: 1, offset: 0 })),
  })

  // 쪽 수는 서버 건수(나 포함)로 — 나를 빼고 세면 마지막 쪽이 사라져 한 명이 안 보일 수 있음
  const total = list.data?.total_count ?? 0
  const pages = pageCount(total, size)
  // 지워서 마지막 쪽이 비면 앞쪽으로 (예: 2쪽의 1명을 삭제)
  useEffect(() => {
    if (list.data && page > pages) set({ page: pages })
  }, [list.data, page, pages, set])

  const job = useMutation({
    mutationFn: ({ kind, id }: Job) =>
      kind === 'approve' || kind === 'activate'
        ? setAdminStatus(id, 'ACTIVE')
        : kind === 'deactivate'
          ? setAdminStatus(id, 'INACTIVE')
          : kind === 'reset'
            ? resetAdminPassword(id)
            : deleteAdmin(id), // 거절 = 삭제 (같은 API)
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: adminQueries.all() }) // 목록 + 탭 건수 한 번에
      setConfirming(null)
    },
    onError: () => setConfirming(null), // 창을 닫고 표 위 한 줄로 오류
  })

  // 본인 줄은 안 보임 (11/02 사용자 — 본인에게 할 수 있는 일이 없음, 내 정보는 11 화면)
  // shortcut: 서버에 '나 빼고' 조건이 없어 받은 쪽에서 거름 → 내가 있는 쪽만 한 줄 적게 보임. 서버가 제외 조건을 주면 그걸로
  const rows: AdminRow[] = (list.data?.data ?? [])
    .filter((a) => a.adminUserSeq !== me?.adminUserSeq)
    .map((a) => ({
      id: a.adminUserSeq,
      name: a.name,
      loginId: a.loginId,
      role: ROLE_LABEL[a.role],
      date: fmtDate(a.createdAt),
      lastLogin: a.lastLoginAt
        ? `${fmtDate(a.lastLoginAt)} ${fmtDateTime(a.lastLoginAt).slice(-5)}`
        : null,
      pending: a.status === 'PENDING',
      actions: actionsOf(a),
    }))
  const find = (id: number) => list.data?.data.find((a) => a.adminUserSeq === id)

  return {
    tabs: ADMIN_TABS.map((t, i) => ({
      key: t.key,
      label: t.label,
      // 관리자 탭 숫자는 나를 뺀 수 (로그인한 나는 늘 ACTIVE)
      count: withoutMe(t.key, counts[i]?.data?.total_count),
    })),
    tab,
    setTab: (key: AdminStatus) => set({ tab: key }),
    q: params.q,
    setQ: (v: string) => set({ q: v }), // 쪽은 1로

    rows,
    isLoading: list.isPending,
    loadError: list.error?.message ?? null,
    // 활성화 탭 = 나를 뺀 수 (탭 숫자와 같게). 검색 결과에 내가 없으면 빼지 않음 (11/09 검수: 2명인데 '1명'으로)
    total:
      !q ||
      [me?.name, me?.loginId].some((s) =>
        s?.normalize('NFC').toLowerCase().includes(q.toLowerCase()),
      )
        ? (withoutMe(tab, total) ?? total)
        : total,
    page: Math.min(page, pages),
    pages,
    setPage: (p: number) => set({ page: p }),

    // 승인: 확인 창 없이 바로. 그 줄만 '처리 중'
    approve: (id: number) => job.mutate({ kind: 'approve', id }),
    activate: (id: number) => job.mutate({ kind: 'activate', id }), // 승인처럼 확인 없이 바로
    busyId: job.isPending ? job.variables?.id : undefined,
    jobError: job.error?.message ?? null,

    confirming,
    ask: (kind: NonNullable<Confirming>['kind'], id: number) => {
      const admin = find(id)
      if (admin) setConfirming({ kind, admin })
    },
    cancel: () => setConfirming(null),
    confirm: () =>
      confirming && job.mutate({ kind: confirming.kind, id: confirming.admin.adminUserSeq }),
    confirmPending: job.isPending,
  }
}
