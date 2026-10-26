import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { authKeys, fetchMe, logout } from '../model/authApi'

/** 로그인한 관리자 정보 · 로그아웃 ViewModel (사이드바 등에서 사용) */
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

  return {
    me: me.data,
    logout: () => logoutMutation.mutate(),
  }
}
