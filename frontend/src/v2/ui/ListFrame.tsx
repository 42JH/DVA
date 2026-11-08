// v2 목록 틀: 흰 표 상자(가로 스크롤은 상자 안에서만), 새 항목 알림 줄, 아래 쪽 이동 줄
import { useEffect, useRef, type ReactNode } from 'react'
import type { useSnapshotList } from '@/v2/lib/useSnapshotList'
import { useScrollable } from '@/v2/lib/useScrollable'
import { Icon } from './index'
import { Pagination } from './Pagination'

type List = ReturnType<typeof useSnapshotList<unknown>>

export function ListFrame({
  list,
  unit,
  empty,
  children,
}: {
  list: Pick<
    List,
    | 'items'
    | 'isLoading'
    | 'isStale'
    | 'error'
    | 'total'
    | 'page'
    | 'size'
    | 'setPage'
    | 'setSize'
    | 'fresh'
    | 'latest'
  >
  unit: string // '주문', '통화'
  empty: string // 조건에 맞는 게 없을 때
  children: ReactNode // <table>
}) {
  const box = useRef<HTMLDivElement>(null)
  // 쪽 · 개수가 바뀌면 상자 맨 위로
  useEffect(() => {
    box.current?.scrollTo({ top: 0 })
  }, [list.page, list.size])

  const scrollable = useScrollable(box, [list.items])

  return (
    <>
      <div
        ref={box}
        aria-busy={list.isStale || list.isLoading}
        data-scrollable={scrollable || undefined}
        className="relative flex min-h-0 flex-1 [scrollbar-width:thin] flex-col overflow-auto rounded-lg border border-ops-line bg-white"
      >
        {list.fresh > 0 && (
          // 기준 시각 이후 새로 들어온 것 — 누를 때만 목록이 바뀜 (보던 줄 · 쪽이 저절로 밀리지 않게)
          <div
            role="status"
            className="sticky top-0 left-0 z-20 flex items-center gap-3 border-b border-ops-route/20 bg-ops-route-soft p-5 text-[13px] text-ops-route"
          >
            새 {unit} {list.fresh.toLocaleString('ko-KR')}건이 들어왔습니다.
            <button
              type="button"
              onClick={list.latest}
              className="font-semibold underline-offset-2 hover:underline"
            >
              최신 목록 보기
            </button>
          </div>
        )}
        <div
          className={`shrink-0 transition-opacity duration-150 ${list.isStale ? 'opacity-50' : ''}`}
        >
          {children}
        </div>
        {list.items.length === 0 &&
          (list.isLoading ? (
            <SkeletonRows />
          ) : (
            <p className="flex flex-1 items-center justify-center py-16 text-center text-[14px] text-ops-sub">
              {list.error ?? empty}
            </p>
          ))}
      </div>
      <Pagination
        page={list.page}
        size={list.size}
        total={list.total}
        onPage={list.setPage}
        onSize={list.setSize}
      />
    </>
  )
}

/** 처음 받는 동안 줄 자리 — 글자 대신 줄 모양 (표가 갑자기 생기며 튀지 않게) */
export function SkeletonRows({ rows = 10 }: { rows?: number }) {
  return (
    <div aria-hidden className="motion-safe:animate-pulse">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-6 border-b border-ops-line/70 px-4">
          <span className="h-3 w-16 rounded bg-ops-idle-soft" />
          <span className="h-3 w-14 rounded bg-ops-idle-soft" />
          <span
            className="h-3 rounded bg-ops-idle-soft"
            style={{ width: `${18 + ((i * 7) % 5) * 4}%` }}
          />
          <span className="h-3 w-24 rounded bg-ops-idle-soft" />
        </div>
      ))}
    </div>
  )
}

/** 화면 위 줄 검색칸 */
export function SearchBox({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string
  onChange: (v: string) => void
  placeholder: string
  label: string
}) {
  return (
    <label className="flex h-9 w-80 items-center gap-2 rounded-md bg-ops-paper px-3 ring-1 ring-transparent focus-within:bg-white focus-within:ring-ops-route max-xl:w-60">
      <Icon name="search" className="size-4 text-ops-faint" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ops-faint"
      />
      {value && (
        <button
          type="button"
          aria-label="검색 지우기"
          onClick={() => onChange('')}
          className="text-ops-faint hover:text-ops-ink"
        >
          <Icon name="x" />
        </button>
      )}
    </label>
  )
}
