import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { fmtDate } from '@/shared/lib/format'
import { pageCount } from '@/shared/api/paging'
import { useListParams } from '@/shared/lib/useListParams'
import { useSession } from '@/shared/auth/useSession'
import {
  adminQueries,
  approveAdmin,
  deleteAdmin,
  resetAdminPassword,
  type Admin,
  type AdminStatus,
} from '@/features/admin/api/adminApi'
import { ADMIN_TABS, ROLE_LABEL } from '@/features/admin/labels'

const PAGE_SIZE = 11 // 디자인: 한 쪽 11명
const DEFAULTS: { tab: AdminStatus } = { tab: 'ACTIVE' } // 디자인 첫 화면 = '관리자' 탭

/** ⋮ 메뉴 항목. deactivate · activate는 API가 없어 꺼 둠(backend-todo 9) */
export type AdminAction = 'reset' | 'deactivate' | 'activate' | 'delete'

/** 확인 창 — 승인은 바로(디자인), 나머지 셋은 확인 후 */
type Confirming = { kind: 'reject' | 'delete' | 'reset'; admin: Admin } | null
type Job = { kind: 'approve' | 'reject' | 'delete' | 'reset'; id: number }

export interface AdminRow {
  id: number
  name: string
  loginId: string
  role: string // '최고 관리자' · '일반 관리자'
  date: string // 가입 신청일 '2026.03.02'
  isMe: boolean // '본인' 태그, 메뉴 없음
  pending: boolean // 승인 대기 탭 줄 → [승인] [거절]
  actions: AdminAction[] // ⋮ 메뉴 (빈 배열이면 ⋮ 없음)
}

// 서버가 막는 일은 처음부터 안 보임: 본인 = 없음, 다른 최고 관리자 = 초기화만 (권한 변경 · 삭제 불가)
function actionsOf(a: Admin, isMe: boolean): AdminAction[] {
  if (isMe || a.status === 'PENDING') return []
  if (a.role === 'SYSTEM_ADMIN') return ['reset']
  return ['reset', a.status === 'INACTIVE' ? 'activate' : 'deactivate', 'delete']
}

/** 10 관리자 권한 관리 훅 — 탭 · 쪽(URL) · 목록 · 탭 건수 · 줄마다 할 수 있는 일 · 확인 창 · 요청 */
export function useAdminList() {
  const { params, page, set } = useListParams(DEFAULTS)
  // 주소창에 엉뚱한 값(?tab=foo)이 와도 기본 탭으로
  const tab = ADMIN_TABS.some((t) => t.key === params.tab) ? params.tab : DEFAULTS.tab
  const { me } = useSession()
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState<Confirming>(null)

  const list = useQuery(
    adminQueries.list({ status: tab, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
  )
  // 탭 건수: 상태마다 1건만 받아 total_count만 씀
  const counts = useQueries({
    queries: ADMIN_TABS.map((t) => adminQueries.list({ status: t.key, limit: 1, offset: 0 })),
  })

  const total = list.data?.total_count ?? 0
  const pages = pageCount(total, PAGE_SIZE)
  // 지워서 마지막 쪽이 비면 앞쪽으로 (예: 2쪽의 1명을 삭제)
  useEffect(() => {
    if (list.data && page > pages) set({ page: pages })
  }, [list.data, page, pages, set])

  const job = useMutation({
    mutationFn: ({ kind, id }: Job) =>
      kind === 'approve'
        ? approveAdmin(id)
        : kind === 'reset'
          ? resetAdminPassword(id)
          : deleteAdmin(id), // 거절 = 삭제 (같은 API)
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: adminQueries.all() }) // 목록 + 탭 건수 한 번에
      setConfirming(null)
    },
    onError: () => setConfirming(null), // 창을 닫고 표 위 한 줄로 오류
  })

  const rows: AdminRow[] = (list.data?.data ?? []).map((a) => {
    const isMe = a.adminUserSeq === me?.adminUserSeq
    return {
      id: a.adminUserSeq,
      name: a.name,
      loginId: a.loginId,
      role: ROLE_LABEL[a.role],
      date: fmtDate(a.createdAt),
      isMe,
      pending: a.status === 'PENDING',
      actions: actionsOf(a, isMe),
    }
  })
  const find = (id: number) => list.data?.data.find((a) => a.adminUserSeq === id)

  return {
    tabs: ADMIN_TABS.map((t, i) => ({
      key: t.key,
      label: t.label,
      count: counts[i]?.data?.total_count,
      countKind: t.key === 'PENDING' ? ('red' as const) : undefined, // 승인 대기 = 빨간 숫자
    })),
    tab,
    setTab: (key: AdminStatus) => set({ tab: key }),

    rows,
    isLoading: list.isPending,
    loadError: list.error?.message ?? null,
    page: Math.min(page, pages),
    pages,
    setPage: (p: number) => set({ page: p }),

    // 승인: 확인 창 없이 바로. 그 줄만 '처리 중'
    approve: (id: number) => job.mutate({ kind: 'approve', id }),
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
