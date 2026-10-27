import { Link } from 'react-router'
import { Button, PageHeader } from '@/shared/ui'

/** 권한 없음 화면 — RequireRole이 막았을 때, 또는 API가 403을 줬을 때 (ErrorNotice가 안내) */
export function ForbiddenPage() {
  return (
    <>
      <PageHeader title="권한 없음" />
      <section className="grid justify-items-start gap-4">
        <p className="text-body text-sub">
          이 화면은 슈퍼바이저만 볼 수 있어요. 필요하면 슈퍼바이저에게 요청해 주세요.
        </p>
        <Link to="/">
          <Button>홈으로</Button>
        </Link>
      </section>
    </>
  )
}
