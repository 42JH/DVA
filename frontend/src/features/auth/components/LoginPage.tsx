import { Link } from 'react-router'
import { useLogin } from '@/features/auth/hooks/useLogin'

// 00 로그인 View — 모양은 임시. 디자인(와이어프레임 v2 '00_로그인')이 나오면 클래스만 바꿈
export function LoginPage() {
  const vm = useLogin()

  return (
    <main className="grid h-full place-items-center">
      <form
        className="grid w-[440px] gap-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (vm.canSubmit) vm.submit()
        }}
      >
        <h1 className="text-title font-bold">관리자 로그인</h1>
        <label className="grid gap-1 text-label">
          이메일
          <input
            className="border-b border-line py-2 text-body outline-none focus:border-action"
            value={vm.loginId}
            onChange={(e) => vm.setLoginId(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label className="grid gap-1 text-label">
          비밀번호
          <input
            className="border-b border-line py-2 text-body outline-none focus:border-action"
            type="password"
            value={vm.password}
            onChange={(e) => vm.setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {vm.errorMessage && (
          <p role="alert" className="text-label text-danger">
            {vm.errorMessage}
          </p>
        )}
        <div className="flex items-center justify-between">
          <Link to="/signup" className="text-label font-semibold text-action">
            회원가입
          </Link>
          <button
            type="submit"
            disabled={!vm.canSubmit}
            className="h-10 rounded-lg bg-action px-5 text-label font-semibold text-white disabled:bg-bg disabled:text-muted"
          >
            {vm.isSubmitting ? '로그인 중…' : '로그인'}
          </button>
        </div>
      </form>
    </main>
  )
}
