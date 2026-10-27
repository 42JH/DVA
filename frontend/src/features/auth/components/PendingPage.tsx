import { Navigate } from 'react-router'
import { Button } from '@/shared/ui'
import { useSession } from '@/shared/auth/useSession'

// 00 승인 대기 View — 가입은 됐지만 슈퍼바이저 승인 전. 모양은 임시(와이어프레임 '00_로그인_승인대기' 반영은 00 작업 때)
export function PendingPage() {
  const vm = useSession()
  if (vm.isLoading) return null
  if (!vm.isPending) return <Navigate to="/" replace /> // 승인된 계정이 주소로 들어오면 홈으로
  return (
    <main className="grid h-full place-items-center">
      <section className="grid w-[440px] justify-items-start gap-4">
        <h1 className="text-title font-bold">승인 대기 중</h1>
        <p className="text-body text-sub">
          {vm.me?.loginId} 계정은 아직 승인 전이에요. 슈퍼바이저가 승인하면 바로 쓸 수 있어요.
        </p>
        <Button onClick={vm.logout}>로그아웃</Button>
      </section>
    </main>
  )
}
