import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/shared/api/client'
import { login } from '@/features/auth/api/loginApi'
import { sessionQueries } from '@/shared/auth/sessionApi'

/** 00 로그인 훅 — 입력값 · 제출 · 오류 문구 */
export function useLogin() {
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/'

  const mutation = useMutation({
    mutationFn: () => login(loginId.trim(), password),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: sessionQueries.all() }) // 이전 계정의 내 정보가 남지 않게
      navigate(from, { replace: true })
    },
  })

  const error = mutation.error
  // 명세(API-01): ACTIVE 계정만 로그인됨 — 승인 대기 계정도 틀린 비밀번호와 같은 401이라 문구에 함께 안내 (BE 요청 B1: 상태 코드가 오면 /pending으로)
  // 400(아이디 형식 · 6자 미만)도 같은 문구 — 서버의 일반 문구를 그대로 띄우지 않게
  const errorMessage = !error
    ? null
    : error instanceof ApiError && (error.status === 401 || error.status === 400)
      ? '아이디 또는 비밀번호가 일치하지 않거나, 아직 승인되지 않은 계정입니다.'
      : error.message

  return {
    loginId,
    password,
    setLoginId,
    setPassword,
    canSubmit: loginId.trim() !== '' && password !== '' && !mutation.isPending,
    isSubmitting: mutation.isPending,
    errorMessage,
    submit: () => mutation.mutate(),
  }
}
