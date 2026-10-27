import { isRouteErrorResponse, Link, useRouteError } from 'react-router'
import { Button } from '@/shared/ui'

/** 루트 라우트 에러 경계 — 화면을 그리다 난 예외를 받아 빈 화면 대신 안내 (컨벤션 7.3). API 오류는 각 화면의 ErrorNotice가 맡음 */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : '알 수 없는 오류'
  return (
    <main className="grid h-full place-items-center">
      <section className="grid w-[440px] justify-items-start gap-4">
        <h1 className="text-title font-bold">화면을 그리지 못했어요</h1>
        <p className="text-body text-sub">{message}</p>
        <Link to="/" reloadDocument>
          <Button>홈으로</Button>
        </Link>
      </section>
    </main>
  )
}
