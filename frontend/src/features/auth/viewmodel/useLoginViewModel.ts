import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '../../../shared/api/client'
import { login } from '../model/authApi'

/** 00 로그인 ViewModel — 입력값 · 제출 · 오류 문구 */
export function useLoginViewModel() {
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const navigate = useNavigate()
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/'

  const mutation = useMutation({
    mutationFn: () => login(loginId.trim(), password),
    onSuccess: () => navigate(from, { replace: true }),
  })

  const error = mutation.error
  // 승인 대기 계정도 명세서상 같은 401 — '승인 대기 중' 안내는 대조표 D7 결정 후
  const errorMessage = !error
    ? null
    : error instanceof ApiError && error.status === 401
      ? '이메일 또는 비밀번호를 확인해 주세요.'
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
