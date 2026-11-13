// 화면 틀(사이드바 · 상단 상태)에 필요한 값 — 처리할 건수 · 진행 중 통화 · 지금 AI 상담가 · 로그인한 관리자
// AppLayout이 한 번만 부르고 ShellContext(shared/lib/shell)로 화면에 나눠 줌
import { useQuery } from '@tanstack/react-query'
import { draftList } from '@/features/order/api/draftApi'
import { useSession } from '@/shared/auth/useSession'
import { unansweredQueries } from '@/features/faq/api/unansweredApi'
import { useActiveCallCount } from '@/features/call/hooks/useActiveCallCount'
import { useActivePersonaName } from '@/features/persona/hooks/useActivePersonaName'
import type { Shell } from '@/shared/lib/shell'

export function useShellState(): Shell {
  const session = useSession()
  const calls = useActiveCallCount()
  const persona = useActivePersonaName()
  // 사이드바 숫자 (기업 피드백: 미답변이 숨어 있음 → 메뉴 옆에 늘 보이게)
  // 미완료 = 배송 초안 (055)
  const incomplete = useQuery({
    queryKey: ['screen', 'drafts', 'count', undefined],
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
