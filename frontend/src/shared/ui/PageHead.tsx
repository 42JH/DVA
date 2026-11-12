// 화면 위 줄 — 제목(상세면 '<' 뒤로) · 화면별 내용(검색 등) · 오른쪽 지금 AI 상담가와 진행 통화 수
import type { ReactNode } from 'react'
import { Link, useNavigate } from 'react-router'
import { prevIs } from '@/shared/lib/keepScroll'
import { useShell } from '@/shared/lib/shell'
import { Icon } from './controls'

/** 화면 위 줄 — 제목 · 오른쪽 끝 AI 상담가 상태. children = 제목 옆 도구(검색 · 추가 등) */
/** 화면 위 줄 — 상세 화면은 back을 주면 제목 앞에 '<' (누르면 그 목록으로) */
export function PageHead({
  title,
  back,
  children,
}: {
  title: string
  back?: { to: string; label: string; state?: unknown } // label = 화면 낭독용 '통화 목록으로', state = 링크로 갈 때 넘길 것
  children?: ReactNode
}) {
  const s = useShell()
  const navigate = useNavigate()
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-ops-line bg-white px-6">
      <h1 className="flex items-center gap-1 text-[18px] font-bold">
        {back && (
          <Link
            to={back.to}
            state={back.state}
            // 바로 전이 그 목록이면 뒤로가기 — 보던 필터 · 쪽 · 스크롤 그대로 (링크로 가면 새 기록이라 맨 위)
            onClick={(e) => {
              if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || !prevIs(back.to)) return
              e.preventDefault()
              void navigate(-1)
            }}
            aria-label={back.label}
            title={back.label}
            className="-ml-2 grid size-8 place-items-center rounded-md text-ops-sub hover:bg-ops-paper hover:text-ops-ink"
          >
            <Icon name="chevron" className="size-5 rotate-90" />
          </Link>
        )}
        {title}
      </h1>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {s.persona && (
        <span
          title={s.live ? undefined : '실시간 연결이 끊겨 다시 연결하는 중입니다'}
          className="flex items-center gap-2 text-[13px] font-medium text-ops-sub"
        >
          <span
            aria-hidden
            className={`size-2 rounded-full ${s.live ? 'bg-ops-done' : 'bg-ops-faint'}`}
          />
          <span>{s.persona} AI 상담가</span>
          <span className="ml-2 text-ops-ink tabular-nums">통화 중 {s.liveCalls ?? 0}건</span>
        </span>
      )}
    </header>
  )
}
