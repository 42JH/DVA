import { Link } from 'react-router'
import { Button } from '@/shared/ui'
import { useSignup } from '@/features/auth/hooks/useSignup'
import { AuthField } from './AuthField'
import { AuthError, AuthFooter, AuthLayout } from './AuthLayout'

// 00 회원가입 (디자인/목업 '00_회원가입' 10/30) — 이름 · 아이디 · 비밀번호 · 비밀번호 확인 (이름 먼저). 다 맞아야 [회원가입]이 켜짐
// 신청 = OPERATOR · PENDING (서버가 고정) → 승인 대기 화면
export function SignupPage() {
  const vm = useSignup()

  return (
    <AuthLayout title="회원가입" sub="가입 후 최고 관리자 승인을 거쳐 이용할 수 있습니다">
      <form
        className="flex flex-col"
        onSubmit={(e) => {
          e.preventDefault()
          if (vm.canSubmit) vm.submit()
        }}
      >
        <div className="flex flex-col gap-8">
          <AuthField
            label="이름"
            icon="person"
            placeholder="이름을 입력해주세요"
            autoComplete="name"
            value={vm.form.name}
            onValue={vm.setName}
            error={vm.errors.name}
          />
          <AuthField
            label="아이디"
            icon="id"
            placeholder="아이디를 입력해주세요"
            autoComplete="username"
            maxLength={20}
            value={vm.form.loginId}
            onValue={vm.setLoginId}
            error={vm.errors.loginId}
          />
          <AuthField
            label="비밀번호"
            icon="lock"
            secret
            placeholder="비밀번호를 입력해주세요"
            autoComplete="new-password"
            value={vm.form.password}
            onValue={vm.setPassword}
            error={vm.errors.password}
          />
          <AuthField
            label="비밀번호 확인"
            icon="lock"
            secret
            placeholder="비밀번호를 다시 한 번 입력해주세요"
            autoComplete="new-password"
            value={vm.form.confirm}
            onValue={vm.setConfirm}
            error={vm.errors.confirm}
          />
        </div>

        <AuthError message={vm.errorMessage} />
        <Button kind="primary" tall type="submit" disabled={!vm.canSubmit} className="mt-3 w-full">
          {vm.isSubmitting ? '신청 중…' : '회원가입'}
        </Button>
      </form>

      <AuthFooter>
        계정이 있으신가요?
        <Link
          to={`/login${vm.carry.search}`}
          state={vm.carry.state}
          className="font-bold text-action hover:underline"
        >
          로그인
        </Link>
      </AuthFooter>
    </AuthLayout>
  )
}
