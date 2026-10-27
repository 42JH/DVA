import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { authKeys, fetchMe, logout, type AdminRole } from '../model/authApi'

/**
 * 로그인한 관리자 정보 · 역할 · 로그아웃 ViewModel (사이드바 · 권한 가드 · 삭제 버튼 노출에서 사용)
 * 사용법: const { role, isSystemAdmin, isPending } = useSessionViewModel()
 *  - me는 React Query가 한 번 받아 캐시 → 어디서 불러도 요청은 한 번
 *  - isSystemAdmin: 슈퍼바이저(명세 SYSTEM_ADMIN)만 하는 일(삭제 · 관리자 권한 관리)의 조건
 *  - isPending: 가입은 했지만 승인 전 → RequireAuth가 승인 대기 화면으로 보냄
 */
export function useSessionViewModel() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const me = useQuery({ queryKey: authKeys.me, queryFn: ({ signal }) => fetchMe(signal) })

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSettled: () => {
      queryClient.clear() // 이전 관리자의 화면 데이터가 남지 않게
      navigate('/login', { replace: true })
    },
  })

  const role: AdminRole | undefined = me.data?.role
  return {
    me: me.data,
    isLoading: me.isPending,
    role,
    isSystemAdmin: role === 'SYSTEM_ADMIN',
    isPending: me.data?.status === 'PENDING',
    logout: () => logoutMutation.mutate(),
  }
}
