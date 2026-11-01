import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { logout, sessionQueries, type AdminRole } from './sessionApi'

/**
 * 로그인한 관리자 정보 · 역할 · 로그아웃 (사이드바 · 권한 가드 · 삭제 버튼 노출에서 사용)
 * hooks 역할 — shared/auth는 층 규칙의 예외라 useQuery를 여기서 쓴다 (컨벤션 4.4)
 * 사용법: const { role, isSystemAdmin, status } = useSession()
 *  - me는 React Query가 한 번 받아 캐시 → 어디서 불러도 요청은 한 번
 *  - isSystemAdmin: 최고 관리자(명세 SYSTEM_ADMIN)만 하는 일(삭제 · 관리자 권한 관리)의 조건
 *  - status: PENDING(승인 전) · INACTIVE(비활성화) → RequireAuth가 안내 화면으로 보냄
 */
export function useSession() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useQuery(sessionQueries.me())

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.clear() // 이전 관리자의 화면 데이터가 남지 않게
      navigate('/login', { replace: true })
    },
    onError: () => window.alert('로그아웃하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'), // 공통 토스트가 없어 alert
  })

  const role: AdminRole | undefined = me.data?.role
  return {
    me: me.data,
    isLoading: me.isPending,
    role,
    isSystemAdmin: role === 'SYSTEM_ADMIN',
    status: me.data?.status,
    logout: () => logoutMutation.mutate(),
  }
}
