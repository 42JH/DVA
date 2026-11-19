import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '@/shared/api/client'
import { clearSession } from '@/shared/auth/session'
import { changePassword, type PasswordChangeBody } from '@/features/me/api/passwordApi'
import { PASSWORD_REASON, PASSWORD_REASON_FALLBACK } from '@/features/me/labels'

const MIN_PASSWORD = 6 // 명세 API-05: 새 비밀번호 최소 6자 (회원가입과 같음)
const EMPTY: PasswordChangeBody = { currentPassword: '', newPassword: '', newPasswordConfirm: '' }

/** 11 내 정보 — 비밀번호 변경 훅. 입력 3칸 · 칸별 오류 · 확인 창 · 제출
 * 성공하면 서버가 내 모든 세션을 끊으므로(204) 로그인 표시 · 캐시를 지우고 바로 로그인 화면 (저장 전 확인 창으로 미리 알림) */
export function usePasswordChange() {
  const [form, setForm] = useState(EMPTY)
  const [confirming, setConfirming] = useState(false) // '다시 로그인해야 합니다' 확인 창
  const navigate = useNavigate()
  const qc = useQueryClient()

  const mutation = useMutation({
    mutationFn: () => changePassword(form),
    onSuccess: () => {
      clearSession()
      qc.clear() // 끊긴 세션으로 받은 내 정보 · 목록이 다음 로그인에 남지 않게
      navigate('/login', { replace: true })
    },
    onError: () => setConfirming(false), // 창을 닫고 칸 아래 오류를 보여 줌
  })

  const set = (key: keyof PasswordChangeBody) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (mutation.error) mutation.reset() // 고치기 시작하면 서버 오류 문구는 지움
  }

  // 화면 검사 — 칸에 뭔가 쓴 뒤에만 (빈 칸은 [저장]이 꺼져 있는 것으로 충분)
  const tooShort = form.newPassword !== '' && form.newPassword.length < MIN_PASSWORD
  const mismatch = form.newPasswordConfirm !== '' && form.newPasswordConfirm !== form.newPassword

  // 서버 422(현재 비밀번호 불일치 · 새 비밀번호 조건)는 details의 field로 칸을 고름. 칸을 못 고르면 아래 한 줄로
  const err = mutation.error
  // reason은 코드(INCORRECT_PASSWORD 등) → labels.ts 문구로. 모르는 코드는 일반 문구 (코드를 그대로 보여 주지 않음)
  const serverError = (field: keyof PasswordChangeBody) => {
    const reason =
      err instanceof ApiError ? err.details.find((d) => d.field === field)?.reason : undefined
    return reason && (PASSWORD_REASON[reason] ?? PASSWORD_REASON_FALLBACK)
  }
  const onField =
    err instanceof ApiError &&
    err.details.some((d) =>
      ['currentPassword', 'newPassword', 'newPasswordConfirm'].includes(d.field),
    )
  // 연결이 끊겨 결과를 모를 때: 이미 바뀌었을 수 있어 다시 보내면 '현재 비밀번호 불일치'로 헷갈림
  const unknown = err instanceof ApiError && err.status === 0

  return {
    form,
    setCurrent: set('currentPassword'),
    setNew: set('newPassword'),
    setConfirm: set('newPasswordConfirm'),
    errors: {
      current: serverError('currentPassword'),
      new:
        serverError('newPassword') ??
        (tooShort ? `비밀번호는 ${MIN_PASSWORD}자 이상 입력해 주세요.` : undefined),
      confirm:
        serverError('newPasswordConfirm') ??
        (mismatch ? '비밀번호가 일치하지 않습니다.' : undefined),
    },
    errorMessage:
      !err || onField
        ? null
        : unknown
          ? '결과를 확인하지 못했어요. 새 비밀번호로 로그인되는지 먼저 확인해 주세요.'
          : err.message,
    canSubmit:
      form.currentPassword !== '' &&
      form.newPassword.length >= MIN_PASSWORD &&
      form.newPasswordConfirm === form.newPassword &&
      !mutation.isPending,
    isSubmitting: mutation.isPending,
    confirming,
    askConfirm: () => setConfirming(true), // [저장] → 확인 창
    cancelConfirm: () => setConfirming(false),
    submit: () => mutation.mutate(), // 확인 창 [바꾸기]
  }
}
