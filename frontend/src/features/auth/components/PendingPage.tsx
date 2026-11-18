import { useNavigate } from 'react-router'
import { clearSession } from '@/shared/auth/session'
import { Button } from '@/shared/ui'
import { AuthLayout } from './AuthLayout'

// 00 승인 대기 중 (디자인/목업 '00_회원가입_완료&로그인_승인대기' 10/30) — 가입 직후 · PENDING 계정이 로그인했을 때 같은 화면
// 로그인 안 한 채로도 오므로(가입 직후) 세션을 보지 않는 그냥 안내 화면
export function PendingPage() {
  const navigate = useNavigate()
  return (
    <AuthLayout
      icon={
        <svg
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinejoin="round"
          aria-hidden
          className="size-12 text-brand"
        >
          <path d="M14 6h20c0 9-6 12-6 18s6 9 6 18H14c0-9 6-12 6-18s-6-9-6-18z" />
        </svg>
      }
      title="승인 대기 중"
      sub={
        '가입 신청이 완료되었습니다.\n최고 관리자 승인 후 로그인할 수 있으며,\n승인 여부는 로그인을 시도해 확인해 주세요.'
      }
    >
      <Button
        kind="primary"
        tall
        className="w-full"
        onClick={() => {
          clearSession() // 승인 전 계정의 로그인 표시가 남으면 로그인 화면 → 홈 → 다시 여기로 돌아옴 (11/09 검수)
          navigate('/login')
        }}
      >
        로그인으로
      </Button>
    </AuthLayout>
  )
}
