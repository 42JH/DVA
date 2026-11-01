import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/shared/ui'
import { useLogin } from '@/features/auth/hooks/useLogin'
import { AuthField } from './AuthField'
import { AuthError, AuthFooter, AuthLayout } from './AuthLayout'

// 00 로그인 (디자인/목업 '00_로그인' · '_입력오류' · '_비밀번호를 잊으셨나요' 10/30)
// '비밀번호를 잊으셨나요?' = 안내 말풍선만 (로그인 전 비밀번호 찾기 없음 — 초기화는 최고 관리자, AUTH-08)
export function LoginPage() {
  const vm = useLogin()
  const [tip, setTip] = useState(false)

  return (
    <AuthLayout title="관리자 로그인" sub="디버 택배 AI 전화 접수 관리자 웹">
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          if (vm.canSubmit) vm.submit()
        }}
      >
        <div className="flex flex-col gap-8">
          <AuthField
            label="아이디"
            icon="id"
            placeholder="아이디를 입력해주세요"
            autoComplete="username"
            value={vm.loginId}
            onValue={vm.setLoginId}
          />
          <AuthField
            label="비밀번호"
            icon="lock"
            secret
            placeholder="비밀번호를 입력해주세요"
            autoComplete="current-password"
            value={vm.password}
            onValue={vm.setPassword}
          />
        </div>

        <div className="relative mt-2 self-end">
          <button
            type="button"
            onClick={(e) => {
              e.currentTarget.focus() // Safari는 버튼을 눌러도 포커스를 안 줘서 바깥을 눌러도 onBlur가 안 뜸
              setTip((v) => !v)
            }}
            onBlur={() => setTip(false)}
            onKeyDown={(e) => e.key === 'Escape' && setTip(false)}
            aria-expanded={tip}
            aria-describedby={tip ? 'pw-tip' : undefined}
            className="px-2 text-caption text-sub hover:text-ink"
          >
            비밀번호를 잊으셨나요?
          </button>
          {tip && (
            <p
              id="pw-tip"
              role="tooltip"
              className="absolute top-full right-0 z-10 mt-2.5 rounded-lg bg-ink px-3 py-2 text-caption whitespace-nowrap text-white"
            >
              <i className="absolute -top-1 right-5 size-2 rotate-45 bg-ink" />
              비밀번호 초기화는 최고 관리자에게 요청해 주세요.
            </p>
          )}
        </div>

        <AuthError message={vm.errorMessage} />
        <Button kind="primary" tall type="submit" disabled={!vm.canSubmit} className="mt-3 w-full">
          {vm.isSubmitting ? '로그인 중…' : '로그인'}
        </Button>
      </form>

      <AuthFooter>
        계정이 없으신가요?
        <Link
          to={`/signup${vm.carry.search}`}
          state={vm.carry.state}
          className="font-bold text-action hover:underline"
        >
          회원가입
        </Link>
      </AuthFooter>
    </AuthLayout>
  )
}
