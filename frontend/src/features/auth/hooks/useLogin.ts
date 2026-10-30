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
  // 승인 대기 · 비활성화 계정은 로그인은 되고 내 정보(status)로 안내 화면에 감 (RequireAuth)
  const errorMessage = !error
    ? null
    : error instanceof ApiError && error.status === 401
      ? '아이디 또는 비밀번호가 일치하지 않습니다.'
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
