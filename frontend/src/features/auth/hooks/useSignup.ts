import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '@/shared/api/client'
import { signup } from '@/features/auth/api/signupApi'

const MIN_PASSWORD = 6 // 10/30 00 디자인 확정

/** 00 회원가입 훅 — 입력값 · 칸별 오류 · 제출. 성공하면 승인 대기 화면 */
export function useSignup() {
  const [form, setForm] = useState({ loginId: '', password: '', confirm: '', name: '' })
  const navigate = useNavigate()

  const mutation = useMutation({
    mutationFn: () =>
      signup({ loginId: form.loginId.trim(), password: form.password, name: form.name.trim() }),
    onSuccess: () => navigate('/pending', { replace: true }),
  })

  const set = (key: keyof typeof form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (mutation.error) mutation.reset() // 고치기 시작하면 서버 오류 문구는 지움
  }

  // 칸별 오류는 그 칸에 뭔가 쓴 뒤에만 (빈 칸은 버튼이 꺼져 있는 것으로 충분)
  const tooShort = form.password !== '' && form.password.length < MIN_PASSWORD
  const mismatch = form.confirm !== '' && form.confirm !== form.password
  const error = mutation.error
  const duplicate = error instanceof ApiError && error.status === 409

  return {
    form,
    setLoginId: set('loginId'),
    setPassword: set('password'),
    setConfirm: set('confirm'),
    setName: set('name'),
    errors: {
      loginId: duplicate ? '이미 사용 중인 아이디입니다.' : undefined,
      password: tooShort ? `비밀번호는 ${MIN_PASSWORD}자 이상 입력해 주세요.` : undefined,
      confirm: mismatch ? '비밀번호가 일치하지 않습니다.' : undefined,
    },
    errorMessage: error && !duplicate ? error.message : null,
    canSubmit:
      form.loginId.trim() !== '' &&
      form.name.trim() !== '' &&
      form.password.length >= MIN_PASSWORD &&
      form.confirm === form.password &&
      !mutation.isPending,
    isSubmitting: mutation.isPending,
    submit: () => mutation.mutate(),
  }
}
