// v2 틀(사이드바 · 상단 상태)에 필요한 값 — 처리할 건수 · 진행 중 통화 · 지금 AI 상담가 · 로그인한 관리자
import { createContext, useContext } from 'react'
import { useQuery } from '@tanstack/react-query'
import { draftList } from '@/features/order/api/draftApi'
import { useSession } from '@/shared/auth/useSession'
import { unansweredQueries } from '@/features/faq/api/unansweredApi'
import { useActiveCallCount } from '@/features/call/hooks/useActiveCallCount'
import { useActivePersonaName } from '@/features/persona/hooks/useActivePersonaName'

// 틀(V2Layout)이 한 번만 부르고 화면(PageHead · 홈)은 이 값을 씀 — 부를 때마다 진행 통화 SSE가 하나씩 더 열리던 것 (11/09 검수)
export const ShellContext = createContext<ReturnType<typeof useShellState> | null>(null)
export const useShell = () => {
  const s = useContext(ShellContext)
  if (!s) throw new Error('useShell은 V2Layout 안에서만')
  return s
}

export function useShellState() {
  const session = useSession()
  const calls = useActiveCallCount()
  const persona = useActivePersonaName()
  // 사이드바 숫자 (기업 피드백: 미답변이 숨어 있음 → 메뉴 옆에 늘 보이게)
  // 미완료 = 배송 초안 (055)
  const incomplete = useQuery({
    queryKey: ['v2', 'drafts', 'count', undefined],
    queryFn: ({ signal }) => draftList({ limit: 1, offset: 0 }, signal).then((r) => r.total_count),
  })
  const unanswered = useQuery(unansweredQueries.count())
  return {
    name: session.me?.name ?? '',
    isSystemAdmin: session.isSystemAdmin,
    logout: session.logout,
    persona,
    liveCalls: calls.count,
    live: calls.live,
    incomplete: incomplete.data ?? null,
    unanswered: unanswered.data ?? null,
  }
}
