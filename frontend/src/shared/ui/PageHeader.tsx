import type { ReactNode } from 'react'
import { Link } from 'react-router'

// 화면 머리 (와이어프레임 16 Page header) — 높이 64 · 제목 28/700 · 아래 구분선
// back: 상세 화면의 '‹ 목록으로' (06 · 05 상세) — 제목 오른쪽에 남색 18/600. right: 오른쪽 끝 요소(02 비교 기준 등)
export function PageHeader({
  title,
  back,
  right,
}: {
  title: string
  back?: { to: string; label?: string }
  right?: ReactNode
}) {
  return (
    <header className="-mx-content -mt-content mb-6 box-content flex h-16 items-center gap-4 border-b border-line px-content">
      <h1 className="text-title font-bold">{title}</h1>
      {back && (
        <Link to={back.to} className="text-label font-semibold text-action">
          ‹ {back.label ?? '목록으로'}
        </Link>
      )}
      {right && <div className="ml-auto flex items-center gap-3 text-label text-sub">{right}</div>}
    </header>
  )
}
