import { Link } from 'react-router'
import { Button } from '@/shared/ui'

/** 권한 없음 — RequireRole이 막았을 때. 상단바 제목은 그 경로의 제목 그대로 (예: 관리자 권한 관리) */
export function ForbiddenPage() {
  return (
    <section className="grid justify-items-start gap-4">
      <p className="text-body text-sub">
        이 화면은 최고 관리자만 볼 수 있어요. 필요하면 최고 관리자에게 요청해 주세요.
      </p>
      <Link to="/">
        <Button>홈으로</Button>
      </Link>
    </section>
  )
}
