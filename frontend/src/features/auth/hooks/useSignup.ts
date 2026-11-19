import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/shared/api/client'
import { signup } from '../api/signupApi'

const MIN_PASSWORD = 6 // 10/30 00 디자인 확정 · 명세 API-02
const LOGIN_ID = /^[A-Za-z0-9]{1,20}$/ // 명세 API-02: 영문 · 숫자 1~20자, 대소문자 구분 (소문자로 바꾸지 않음)
const FIELD_TEXT: Record<string, string> = {
  loginId: '아이디는 영문, 숫자 1~20자로 입력해 주세요.',
  password: `비밀번호는 ${MIN_PASSWORD}자 이상 입력해 주세요.`,
  name: '이름을 입력해 주세요.',
}

/** 00 회원가입 훅 — 입력값 · 칸별 오류 · 제출. 성공하면 승인 대기 화면 */
export function useSignup() {
  const [form, setForm] = useState({ loginId: '', password: '', confirm: '', name: '' })
  const navigate = useNavigate()
  const location = useLocation()

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
  const badId = form.loginId.trim() !== '' && !LOGIN_ID.test(form.loginId.trim())
  const tooShort = form.password !== '' && form.password.length < MIN_PASSWORD
  const mismatch = form.confirm !== '' && form.confirm !== form.password
  const error = mutation.error
  const duplicate = error instanceof ApiError && error.status === 409
  // 400 details[].field(loginId · password · name) → 그 칸의 고정 문구 (서버 reason은 코드일 수 있어 그대로 안 보여 줌)
  const serverField = (field: string) =>
    error instanceof ApiError &&
    error.status === 400 &&
    error.details.some((d) => d.field === field)
      ? FIELD_TEXT[field]
      : undefined

  return {
    form,
    carry: { search: location.search, state: location.state as unknown }, // 로그인으로 돌아가도 돌아갈 화면 그대로
    setLoginId: set('loginId'),
    setPassword: set('password'),
    setConfirm: set('confirm'),
    setName: set('name'),
    errors: {
      loginId: duplicate
        ? '이미 사용 중인 아이디입니다.'
        : badId
          ? FIELD_TEXT.loginId
          : serverField('loginId'),
      password: tooShort ? FIELD_TEXT.password : serverField('password'),
      confirm: mismatch ? '비밀번호가 일치하지 않습니다.' : undefined,
      name: serverField('name'),
    },
    errorMessage:
      error &&
      !duplicate &&
      !(error instanceof ApiError && error.status === 400 && error.details.length)
        ? error.message
        : null,
    canSubmit:
      LOGIN_ID.test(form.loginId.trim()) &&
      form.name.trim() !== '' &&
      form.password.length >= MIN_PASSWORD &&
      form.confirm === form.password &&
      !mutation.isPending,
    isSubmitting: mutation.isPending,
    submit: () => mutation.mutate(),
  }
}
