import { useNavigate } from 'react-router'
import { Button } from '@/shared/ui'
import { AuthLayout } from './AuthLayout'

// 00 비활성화 (디자인/목업 '00_로그인_승인거절' 10/30) — 최고 관리자가 비활성화한 계정이 로그인했을 때
// 디자인의 주황 '!'는 토큰에 주황이 없어 빨강(danger)
export function InactivePage() {
  const navigate = useNavigate()
  return (
    <AuthLayout
      icon={
        <svg
          viewBox="0 0 48 48"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          aria-hidden
          className="size-12 text-danger"
        >
          <circle cx="24" cy="24" r="20" />
          <path d="M24 14v12M24 33v.5" />
        </svg>
      }
      title="비활성화"
      sub={'비활성화 된 계정입니다.\n자세한 내용은 최고 관리자에게 문의해 주세요.'}
    >
      <Button kind="primary" tall className="w-full" onClick={() => navigate('/login')}>
        로그인으로
      </Button>
    </AuthLayout>
  )
}
