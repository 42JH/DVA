import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '@/shared/api/client'
import { login } from '@/features/auth/api/loginApi'

/** 00 로그인 훅 — 입력값 · 제출 · 오류 문구 */
export function useLogin() {
  const [loginId, setLoginId] = useState('')
  const [password, setPassword] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const location = useLocation()
  // 돌아갈 화면: 가드가 넘긴 state.from, 없으면 세션 만료 때 붙인 ?from= (client.ts)
  // ?from=은 주소라 누구나 바꿀 수 있음 → 앱 안 경로만 ('//' · '/\'로 시작하면 다른 사이트로 가므로 버림)
  const q = new URLSearchParams(location.search).get('from')
  const from =
    (location.state as { from?: string } | null)?.from ?? (q && /^\/(?![/\\])/.test(q) ? q : '/')

  const mutation = useMutation({
    mutationFn: (v: { loginId: string; password: string }) => login(v.loginId.trim(), v.password),
    onSuccess: () => {
      queryClient.clear() // 이전 계정의 내 정보 · 목록이 남지 않게 (세션 만료 뒤 다른 계정 로그인)
      navigate(from, { replace: true })
    },
  })

  // 고치기 시작하면 오류 문구는 지움 (회원가입과 같게)
  const set = (fn: (v: string) => void) => (v: string) => {
    fn(v)
    if (mutation.error) mutation.reset()
  }

  const error = mutation.error
  // 명세(API-01): ACTIVE 계정만 로그인됨 — 승인 대기 · 비활성화 · 삭제도 틀린 비밀번호와 같은 401이라 한 문구로 (피드백: 삭제된 계정에 '승인되지 않은' 안내는 틀림. BE 요청 B1: 상태 코드가 오면 /pending으로)
  // 400(아이디 형식 · 6자 미만)도 같은 문구 — 서버의 일반 문구를 그대로 띄우지 않게
  const errorMessage = !error
    ? null
    : error instanceof ApiError && (error.status === 401 || error.status === 400)
      ? '아이디 또는 비밀번호가 올바르지 않습니다.'
      : error.message

  return {
    loginId,
    password,
    setLoginId: set(setLoginId),
    setPassword: set(setPassword),
    carry: { search: location.search, state: location.state as unknown }, // 회원가입으로 갔다 와도 돌아갈 화면 그대로
    canSubmit: loginId.trim() !== '' && password !== '' && !mutation.isPending,
    isSubmitting: mutation.isPending,
    errorMessage,
    // 값은 누른 순간 칸에서 직접 읽음: 크롬 자동 완성은 사용자가 화면을 누르기 전엔 입력 이벤트가 없어 상태가 빈 채일 수 있음
    submit: (form: HTMLFormElement) => {
      const f = new FormData(form)
      const id = String(f.get('loginId') ?? '')
      const pw = String(f.get('password') ?? '')
      setLoginId(id) // 화면 상태도 칸 값에 맞춤
      setPassword(pw)
      if (id.trim() !== '' && pw !== '' && !mutation.isPending)
        mutation.mutate({ loginId: id, password: pw })
    },
  }
}
