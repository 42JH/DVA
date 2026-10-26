// 페이지 번호 — 카드 아래 가운데. ‹ 1 2 3 4 5 … 13 › 칸 36 · 사이 4, 지금 쪽 = 남색 바탕 흰 글자
// 총 쪽수를 모르면(D2 미결 — 명세서는 hasNext만 줌) ‹ 현재 › 만 보여 준다

function pageItems(page: number, pages: number): (number | '…')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  if (page <= 4) return [1, 2, 3, 4, 5, '…', pages]
  if (page >= pages - 3) return [1, '…', pages - 4, pages - 3, pages - 2, pages - 1, pages]
  return [1, '…', page - 1, page, page + 1, '…', pages]
}

export function Pagination({
  page,
  pages,
  hasNext,
  onChange,
}: {
  page: number // 1부터
  pages?: number // 총 쪽수. 모르면 생략하고 hasNext만
  hasNext?: boolean
  onChange: (page: number) => void
}) {
  const items = pages ? pageItems(page, pages) : [page]
  const prevOff = page <= 1
  const nextOff = pages ? page >= pages : !hasNext
  const arrow = (dir: 'prev' | 'next', off: boolean) => (
    <button
      type="button"
      disabled={off}
      aria-label={dir === 'prev' ? '이전 쪽' : '다음 쪽'}
      onClick={() => onChange(page + (dir === 'prev' ? -1 : 1))}
      className={`grid size-9 place-items-center rounded-lg ${off ? 'text-muted' : 'text-sub hover:bg-bg'}`}
    >
      <svg
        viewBox="0 0 20 20"
        className="size-4"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {dir === 'prev' ? <path d="M12 5l-5 5 5 5" /> : <path d="M8 5l5 5-5 5" />}
      </svg>
    </button>
  )
  return (
    <nav className="flex items-center justify-center gap-1" aria-label="페이지">
      {arrow('prev', prevOff)}
      {items.map((it, i) =>
        it === '…' ? (
          <span key={`e${i}`} className="grid size-9 place-items-center text-label text-sub">
            …
          </span>
        ) : (
          <button
            key={it}
            type="button"
            aria-current={it === page ? 'page' : undefined}
            onClick={() => onChange(it)}
            className={`grid size-9 place-items-center rounded-lg text-label ${
              it === page ? 'bg-action font-bold text-white' : 'text-sub hover:bg-bg'
            }`}
          >
            {it}
          </button>
        ),
      )}
      {arrow('next', nextOff)}
    </nav>
  )
}
