import { useEffect, useState } from 'react'

// 04 통화 검색 (Figma '통화' 11/04 — 머리 오른쪽 밑줄 칸, 폭 322) — 창을 띄우지 않고 이 칸에 바로 침 (11/04 사용자)
// 치는 대로 아래 목록이 바로 바뀜: 0.25초 멈추면 적용(칠 때마다 요청하지 않게), Enter는 바로, ✕ · Esc는 지움
// 이름 · 전화번호 부분 검색은 서버(q). 끝에 덜 친 자모('김ㅁ')는 떼고 보냄 — 치는 도중 목록이 비었다 차지 않게
const clean = (v: string) => v.trim().replace(/[ㄱ-ㅎㅏ-ㅣ]+$/, '')

export function CallSearch({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const [text, setText] = useState(q)
  useEffect(() => {
    const t = setTimeout(() => onSearch(clean(text)), 250)
    return () => clearTimeout(t)
  }, [text]) // eslint-disable-line react-hooks/exhaustive-deps -- 친 글이 바뀔 때만 (onSearch는 렌더마다 새 함수)
  const clear = () => {
    setText('')
    onSearch('')
  }

  return (
    <div className="flex h-[37px] w-[322px] items-start gap-[13px] border-b border-line pt-0.5 focus-within:border-brand">
      <svg
        viewBox="0 0 20 20"
        className="mt-0.5 size-5 shrink-0 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        aria-hidden
      >
        <circle cx="8.5" cy="8.5" r="6" />
        <path d="M13 13l4.5 4.5" />
      </svg>
      <input
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return // 한글 조합을 끝내는 Enter
          if (e.key === 'Enter') onSearch(clean(text))
          else if (e.key === 'Escape') clear()
        }}
        placeholder="이름 · 전화번호"
        aria-label="통화 검색 (이름 · 전화번호)"
        className="min-w-0 flex-1 bg-transparent text-card leading-6 outline-none placeholder:text-muted [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          aria-label="검색 지우기"
          onClick={clear}
          className="grid size-7 shrink-0 place-items-center rounded text-sub hover:bg-bg hover:text-ink"
        >
          <svg viewBox="0 0 20 20" className="size-4 stroke-current" strokeWidth={1.8} aria-hidden>
            <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  )
}
