import { useEffect, useState } from 'react'
import { isRouteErrorResponse, useRouteError } from 'react-router'
import { Button } from '@/shared/ui'

// 배포하면 서버의 옛 화면 파일이 지워짐 → 배포 전에 열어 둔 탭은 아직 안 연 화면 파일을 못 받음 (브라우저마다 다른 문구)
// 이땐 새로고침 한 번으로 새 판을 받음. 1분 안에 또 나면 진짜 없는 파일 → 안내 화면 (끝없는 새로고침 방지)
const STALE_FILE =
  /dynamically imported module|Importing a module script failed|Unable to preload CSS/i
const RELOADED_AT = 'route-error-reloaded-at'
const reloadedLately = () => Date.now() - Number(sessionStorage.getItem(RELOADED_AT)) < 60_000

/** 루트 라우트 에러 경계 — 화면을 그리다 난 예외를 받아 빈 화면 대신 안내 (컨벤션 7.3). API 오류는 각 화면이 그 자리에 문구로 보여 줌 */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : '알 수 없는 오류'
  const [stale] = useState(() => STALE_FILE.test(message) && !reloadedLately())
  useEffect(() => {
    if (!stale) return
    sessionStorage.setItem(RELOADED_AT, String(Date.now()))
    window.location.reload()
  }, [stale])
  if (stale) return null // 새로고침되는 동안 안내 화면을 번쩍 띄우지 않음
  return (
    <main className="grid h-full place-items-center">
      <section className="grid w-[440px] justify-items-start gap-4">
        <h1 className="text-title font-bold">화면을 그리지 못했어요</h1>
        <p className="min-w-0 text-body break-words text-sub">{message}</p>
        {/* 새로고침으로 홈 — 망가진 화면 상태를 통째로 버림 */}
        <Button onClick={() => window.location.assign('/')}>홈으로</Button>
      </section>
    </main>
  )
}
